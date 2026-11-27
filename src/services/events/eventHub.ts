import type { Dashboard } from "../../domain/dashboard/types";
import type {
	ChangeFeed,
	ChangeNotice,
	EventHub,
	StreamEvent,
	StreamSink,
} from "../../domain/events/types";
import type { Incident, IncidentRepository, IncidentView } from "../../domain/incidents/types";
import type { OnCallRepository } from "../../domain/onCall/types";
import type { Principal, TenantId } from "../../domain/shared/identity";
import type { SummaryDraftRepository } from "../../domain/summaries/types";

// Spec: docs/features/realtime-status.md, "How it works".

export const MAX_STREAMS_PER_MEMBER = 5;
export const MAX_BUFFERED_EVENTS = 100;
export const DASHBOARD_DELAY_MS = 1000;

export type EventHubDeps = {
	feed: ChangeFeed;
	incidents: Pick<IncidentRepository, "findById">;
	// Shows incidents exactly as the API does, with the assignee's email.
	views: (tenantId: TenantId, incidents: Incident[]) => Promise<IncidentView[]>;
	schedules: Pick<OnCallRepository, "findById" | "findOverride">;
	drafts: Pick<SummaryDraftRepository, "findById">;
	dashboard: (tenantId: TenantId) => Promise<Dashboard>;
	now?: () => Date;
	maxStreamsPerMember?: number;
	maxBufferedEvents?: number;
	dashboardDelayMs?: number;
	// Gets ids only, never a payload.
	onError?: (subject: string, error: unknown) => void;
};

type Stream = {
	principal: Principal;
	sink: StreamSink;
	// Events not yet written. Beyond the limit the stream is closed: the client resyncs.
	queue: StreamEvent[];
	writing: boolean;
	closed: boolean;
	expiry: ReturnType<typeof setTimeout> | null;
};

export const createEventHub = ({
	feed,
	incidents,
	views,
	schedules,
	drafts,
	dashboard,
	now = () => new Date(),
	maxStreamsPerMember = MAX_STREAMS_PER_MEMBER,
	maxBufferedEvents = MAX_BUFFERED_EVENTS,
	dashboardDelayMs = DASHBOARD_DELAY_MS,
	onError = () => undefined,
}: EventHubDeps): EventHub => {
	// Open streams by tenant, oldest first. The only path from a notice to a stream, so an event
	// can reach only its own tenant's members.
	const streams = new Map<TenantId, Stream[]>();
	// Notices of one tenant are handled one at a time, so events keep commit order.
	const chains = new Map<TenantId, Promise<void>>();
	const dashboardTimers = new Map<TenantId, ReturnType<typeof setTimeout>>();

	const close = (stream: Stream) => {
		if (stream.closed) return;
		stream.closed = true;
		stream.queue = [];
		if (stream.expiry) clearTimeout(stream.expiry);
		const tenant = stream.principal.tenantId;
		const left = (streams.get(tenant) ?? []).filter((other) => other !== stream);
		if (left.length > 0) streams.set(tenant, left);
		else streams.delete(tenant);
		stream.sink.close();
	};

	const drain = async (stream: Stream) => {
		if (stream.writing) return;
		stream.writing = true;
		try {
			for (let event = stream.queue.shift(); event; event = stream.queue.shift()) {
				if (stream.closed) return;
				await stream.sink.write(event);
			}
		} catch {
			// The client went away mid-write.
			close(stream);
		} finally {
			stream.writing = false;
		}
	};

	const send = (stream: Stream, event: StreamEvent) => {
		if (stream.closed) return;
		if (stream.queue.length >= maxBufferedEvents) {
			close(stream);
			return;
		}
		stream.queue.push(event);
		void drain(stream);
	};

	const broadcast = (tenant: TenantId, event: StreamEvent) => {
		for (const stream of streams.get(tenant) ?? []) send(stream, event);
	};

	const inOrder = (tenant: TenantId, subject: string, work: () => Promise<void>) => {
		const next = (chains.get(tenant) ?? Promise.resolve())
			.then(work)
			.catch((error) => onError(subject, error));
		chains.set(tenant, next);
		void next.then(() => {
			if (chains.get(tenant) === next) chains.delete(tenant);
		});
	};

	// Trailing, at most once per delay per tenant: a burst of changes makes one snapshot.
	const scheduleDashboard = (tenant: TenantId) => {
		if (dashboardTimers.has(tenant)) return;
		dashboardTimers.set(
			tenant,
			setTimeout(() => {
				dashboardTimers.delete(tenant);
				inOrder(tenant, `dashboard ${tenant}`, async () => {
					if (!streams.has(tenant)) return;
					broadcast(tenant, { type: "dashboard", dashboard: await dashboard(tenant) });
				});
			}, dashboardDelayMs),
		);
	};

	const handle = async (notice: ChangeNotice) => {
		const tenant = notice.tenantId;
		switch (notice.kind) {
			case "incident": {
				const incident = await incidents.findById(tenant, notice.id as Incident["id"]);
				if (!incident) return;
				const [view] = await views(tenant, [incident]);
				if (view) broadcast(tenant, { type: notice.event, incident: view });
				scheduleDashboard(tenant);
				return;
			}
			case "on_call_schedule": {
				if (notice.event === "on_call_schedule.deleted") {
					broadcast(tenant, { type: notice.event, id: notice.id });
					return;
				}
				const schedule = await schedules.findById(tenant, notice.id);
				if (schedule) broadcast(tenant, { type: notice.event, schedule });
				return;
			}
			case "on_call_override": {
				if (notice.event === "on_call_override.deleted") {
					broadcast(tenant, { type: notice.event, scheduleId: notice.scheduleId, id: notice.id });
					return;
				}
				const override = await schedules.findOverride(tenant, notice.scheduleId, notice.id);
				if (override) {
					broadcast(tenant, { type: notice.event, scheduleId: notice.scheduleId, override });
				}
				return;
			}
			case "summary_draft": {
				const draft = await drafts.findById(tenant, notice.id);
				if (draft)
					broadcast(tenant, { type: "summary_draft.ready", incidentId: notice.incidentId, draft });
				return;
			}
			case "members_removed": {
				const removed = new Set(notice.userIds);
				for (const stream of [...(streams.get(tenant) ?? [])]) {
					if (removed.has(stream.principal.userId)) close(stream);
				}
				// Their incidents were unassigned in the same change: everyone refetches.
				broadcast(tenant, { type: "resync" });
				return;
			}
		}
	};

	const unsubscribe = feed.subscribe((item) => {
		if (item.kind === "resync") {
			for (const tenant of streams.keys()) broadcast(tenant, { type: "resync" });
			return;
		}
		// Most notices are for tenants with nobody watching on this instance.
		if (!streams.has(item.tenantId)) return;
		inOrder(item.tenantId, `${item.kind} notice`, () => handle(item));
	});

	return {
		connect(principal, sink) {
			const stream: Stream = {
				principal,
				sink,
				queue: [],
				writing: false,
				closed: false,
				expiry: null,
			};
			const tenant = principal.tenantId;
			const open = [...(streams.get(tenant) ?? []), stream];
			streams.set(tenant, open);
			// Many tabs: the oldest of the member's streams makes way.
			const own = open.filter((other) => other.principal.userId === principal.userId);
			for (const oldest of own.slice(0, Math.max(0, own.length - maxStreamsPerMember))) {
				close(oldest);
			}
			if (principal.expiresAt) {
				const left = principal.expiresAt.getTime() - now().getTime();
				// setTimeout holds at most about 24.8 days; tokens live far less.
				stream.expiry = setTimeout(() => close(stream), Math.max(0, Math.min(left, 2 ** 31 - 1)));
			}
			send(stream, { type: "ready" });
			return () => close(stream);
		},

		shutdown() {
			unsubscribe();
			for (const timer of dashboardTimers.values()) clearTimeout(timer);
			dashboardTimers.clear();
			for (const open of [...streams.values()]) for (const stream of [...open]) close(stream);
		},
	};
};
