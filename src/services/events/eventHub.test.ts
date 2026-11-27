import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncidentId } from "../../contract/incidents";
import type { Dashboard } from "../../domain/dashboard/types";
import type { StreamEvent, StreamSink } from "../../domain/events/types";
import type { Incident } from "../../domain/incidents/types";
import type { OnCallOverride, OnCallSchedule } from "../../domain/onCall/types";
import type { Postmortem, PostmortemDraft } from "../../domain/postmortems/types";
import type { Principal, TenantId } from "../../domain/shared/identity";
import type { SummaryDraft } from "../../domain/summaries/types";
import { InMemoryChangeFeed } from "../../repository/events/inMemoryChangeFeed";
import { createEventHub } from "./eventHub";

// Spec: docs/features/realtime-status.md

const ACME = "tenant-acme" as TenantId;
const GLOBEX = "tenant-globex" as TenantId;
const START = new Date("2026-01-10T12:00:00Z");

const member = (userId: string, tenantId = ACME, expiresAt?: Date): Principal => ({
	tenantId,
	userId,
	role: "responder",
	...(expiresAt ? { expiresAt } : {}),
});

const incident = (id: string, tenantId = ACME): Incident => ({
	id: id as IncidentId,
	tenantId,
	title: "Checkout is down",
	severity: "sev1",
	status: "open",
	createdAt: START,
	createdBy: "user-1",
	acknowledgedAt: null,
	acknowledgedBy: null,
	resolvedAt: null,
	resolvedBy: null,
	alertSourceId: null,
	dedupKey: null,
	alertCount: 0,
	lastAlertAt: null,
	assigneeId: null,
	assignmentCount: 0,
	summary: null,
});

const dashboardOf = (tenantId: TenantId): Dashboard => ({
	generatedAt: START,
	window: null,
	totals: { open: tenantId === ACME ? 1 : 9, acknowledged: 0, unassigned: 0 },
	bySeverity: {
		sev1: { open: 0, acknowledged: 0 },
		sev2: { open: 0, acknowledged: 0 },
		sev3: { open: 0, acknowledged: 0 },
		sev4: { open: 0, acknowledged: 0 },
	},
	load: [],
	assigneeCount: 0,
});

type FakeSink = StreamSink & { events: StreamEvent[]; closed: boolean };

const sink = (): FakeSink => {
	const fake: FakeSink = {
		events: [],
		closed: false,
		async write(event) {
			fake.events.push(event);
		},
		close() {
			fake.closed = true;
		},
	};
	return fake;
};

// A client that stopped reading: writes never finish.
const stuckSink = (): FakeSink => {
	const fake = sink();
	fake.write = () => new Promise(() => {});
	return fake;
};

const types = (fake: FakeSink) => fake.events.map((event) => event.type);

// Lets queued promise callbacks run. Real setImmediate: only setTimeout and Date are faked.
const flush = async () => {
	for (let n = 0; n < 10; n++) await new Promise((resolve) => setImmediate(resolve));
};

describe("event hub", () => {
	let feed: InMemoryChangeFeed;
	let loads: string[];
	let hub: ReturnType<typeof createEventHub>;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: START });
		feed = new InMemoryChangeFeed();
		loads = [];
		hub = createEventHub({
			feed,
			incidents: {
				findById: async (tenantId, id) => {
					loads.push(`incident ${tenantId} ${id}`);
					return id === "gone" ? null : incident(id, tenantId);
				},
			},
			views: async (_tenantId, incidents) => incidents.map((item) => ({ ...item, assignee: null })),
			schedules: {
				findById: async (tenantId, id) => {
					loads.push(`schedule ${tenantId} ${id}`);
					return { id, tenantId } as OnCallSchedule;
				},
				findOverride: async (tenantId, scheduleId, id) => {
					loads.push(`override ${tenantId} ${id}`);
					return { id, tenantId, scheduleId } as OnCallOverride;
				},
			},
			drafts: {
				findById: async (tenantId, id) => {
					loads.push(`draft ${tenantId} ${id}`);
					return { id, tenantId, incidentId: "i-1", state: "ready" } as SummaryDraft;
				},
			},
			postmortemDrafts: {
				findById: async (tenantId, id) => {
					loads.push(`postmortem draft ${tenantId} ${id}`);
					return { id, tenantId, incidentId: "i-1", state: "ready" } as PostmortemDraft;
				},
			},
			postmortems: {
				find: async (tenantId, incidentId) => {
					loads.push(`postmortem ${tenantId} ${incidentId}`);
					return { tenantId, incidentId, state: "published" } as Postmortem;
				},
			},
			dashboard: async (tenantId) => {
				loads.push(`dashboard ${tenantId}`);
				return dashboardOf(tenantId);
			},
			dashboardDelayMs: 1000,
		});
	});

	afterEach(() => {
		hub.shutdown();
		vi.useRealTimers();
	});

	const opened = (id: string, tenantId = ACME) =>
		feed.publishSync({ kind: "incident", tenantId, id, event: "incident.opened" });

	it("sends ready first, then each change of the stream's own tenant only", async () => {
		const grace = sink();
		const frank = sink();
		hub.connect(member("grace"), grace);
		hub.connect(member("frank", GLOBEX), frank);

		opened("i-1");
		opened("i-2", GLOBEX);
		await flush();

		expect(grace.events).toMatchObject([
			{ type: "ready" },
			{ type: "incident.opened", incident: { id: "i-1", tenantId: ACME, assignee: null } },
		]);
		expect(frank.events).toMatchObject([
			{ type: "ready" },
			{ type: "incident.opened", incident: { id: "i-2", tenantId: GLOBEX } },
		]);
	});

	it("ignores a tenant nobody on this instance watches, without loading anything", async () => {
		hub.connect(member("grace"), sink());

		opened("i-1", GLOBEX);
		await flush();
		await vi.advanceTimersByTimeAsync(5000);

		expect(loads).toEqual([]);
	});

	it("sends one dashboard a second after a burst of incident changes", async () => {
		const grace = sink();
		hub.connect(member("grace"), grace);

		for (const id of ["i-1", "i-2", "i-3"]) opened(id);
		await flush();
		expect(types(grace)).not.toContain("dashboard");

		await vi.advanceTimersByTimeAsync(1000);
		await flush();

		expect(types(grace).filter((type) => type === "dashboard")).toHaveLength(1);
		expect(grace.events.at(-1)).toEqual({ type: "dashboard", dashboard: dashboardOf(ACME) });
		expect(loads.filter((load) => load.startsWith("dashboard"))).toEqual([`dashboard ${ACME}`]);
	});

	it("keeps commit order within a tenant even when loads finish out of order", async () => {
		const grace = sink();
		hub.connect(member("grace"), grace);

		feed.publishSync({ kind: "incident", tenantId: ACME, id: "i-1", event: "incident.opened" });
		feed.publishSync({
			kind: "incident",
			tenantId: ACME,
			id: "i-1",
			event: "incident.acknowledged",
		});
		feed.publishSync({ kind: "incident", tenantId: ACME, id: "i-1", event: "incident.resolved" });
		await flush();

		expect(types(grace)).toEqual([
			"ready",
			"incident.opened",
			"incident.acknowledged",
			"incident.resolved",
		]);
	});

	it("skips an incident it cannot load", async () => {
		const grace = sink();
		hub.connect(member("grace"), grace);

		opened("gone");
		await flush();

		expect(types(grace)).toEqual(["ready"]);
	});

	it("sends schedule and override changes, loading only what still exists", async () => {
		const grace = sink();
		hub.connect(member("grace"), grace);

		feed.publishSync({
			kind: "on_call_schedule",
			tenantId: ACME,
			id: "s",
			event: "on_call_schedule.updated",
		});
		feed.publishSync({
			kind: "on_call_schedule",
			tenantId: ACME,
			id: "s",
			event: "on_call_schedule.deleted",
		});
		feed.publishSync({
			kind: "on_call_override",
			tenantId: ACME,
			scheduleId: "s",
			id: "o",
			event: "on_call_override.created",
		});
		feed.publishSync({
			kind: "on_call_override",
			tenantId: ACME,
			scheduleId: "s",
			id: "o",
			event: "on_call_override.deleted",
		});
		await flush();

		expect(grace.events.slice(1)).toEqual([
			{ type: "on_call_schedule.updated", schedule: { id: "s", tenantId: ACME } },
			{ type: "on_call_schedule.deleted", id: "s" },
			{
				type: "on_call_override.created",
				scheduleId: "s",
				override: { id: "o", tenantId: ACME, scheduleId: "s" },
			},
			{ type: "on_call_override.deleted", scheduleId: "s", id: "o" },
		]);
		expect(loads).toEqual([`schedule ${ACME} s`, `override ${ACME} o`]);
	});

	// Spec: docs/features/ai-summaries.md.
	it("sends a finished summary draft, and an incident's summary change with a dashboard", async () => {
		const grace = sink();
		hub.connect(member("grace"), grace);

		feed.publishSync({ kind: "summary_draft", tenantId: ACME, incidentId: "i-1", id: "d-1" });
		feed.publishSync({ kind: "incident", tenantId: ACME, id: "i-1", event: "incident.updated" });
		await flush();
		await vi.advanceTimersByTimeAsync(1000);
		await flush();

		expect(grace.events.slice(1, 3)).toMatchObject([
			{ type: "summary_draft.ready", incidentId: "i-1", draft: { id: "d-1", state: "ready" } },
			{ type: "incident.updated", incident: { id: "i-1" } },
		]);
		expect(types(grace).at(-1)).toBe("dashboard");
	});

	// Spec: docs/features/ai-postmortems.md.
	it("sends a finished postmortem draft and a saved postmortem", async () => {
		const grace = sink();
		hub.connect(member("grace"), grace);

		feed.publishSync({ kind: "postmortem_draft", tenantId: ACME, incidentId: "i-1", id: "p-1" });
		feed.publishSync({ kind: "postmortem", tenantId: ACME, incidentId: "i-1" });
		await flush();

		expect(grace.events.slice(1)).toMatchObject([
			{ type: "postmortem_draft.ready", incidentId: "i-1", draft: { id: "p-1" } },
			{ type: "postmortem.updated", postmortem: { incidentId: "i-1", state: "published" } },
		]);
	});

	it("closes a removed member's streams, and tells the rest of the tenant to resync", async () => {
		const grace = sink();
		const alan = sink();
		const frank = sink();
		hub.connect(member("grace"), grace);
		hub.connect(member("alan"), alan);
		hub.connect(member("frank", GLOBEX), frank);

		feed.publishSync({ kind: "members_removed", tenantId: ACME, userIds: ["grace"] });
		await flush();

		expect(grace.closed).toBe(true);
		expect(types(alan)).toEqual(["ready", "resync"]);
		expect(types(frank)).toEqual(["ready"]);
	});

	it("sends resync to every stream when the feed may have missed notices", async () => {
		const grace = sink();
		const frank = sink();
		hub.connect(member("grace"), grace);
		hub.connect(member("frank", GLOBEX), frank);

		feed.resync();
		await flush();

		expect(types(grace)).toEqual(["ready", "resync"]);
		expect(types(frank)).toEqual(["ready", "resync"]);
	});

	it("closes a member's oldest stream when they open a sixth", async () => {
		const tabs = Array.from({ length: 6 }, () => sink());

		for (const tab of tabs) hub.connect(member("grace"), tab);
		hub.connect(member("alan"), sink());
		await flush();

		expect(tabs.map((tab) => tab.closed)).toEqual([true, false, false, false, false, false]);
	});

	it("closes a stream whose client stops reading, once 100 events wait", async () => {
		const slow = stuckSink();
		const fast = sink();
		hub.connect(member("grace"), slow);
		hub.connect(member("alan"), fast);

		for (let n = 0; n < 101; n++) opened(`i-${n}`);
		await flush();

		expect(slow.closed).toBe(true);
		expect(fast.closed).toBe(false);
		expect(types(fast).filter((type) => type === "incident.opened")).toHaveLength(101);
	});

	it("closes a stream whose write fails, and keeps serving the others", async () => {
		const broken = sink();
		broken.write = async (event) => {
			if (event.type !== "ready") throw new Error("socket closed");
		};
		const healthy = sink();
		hub.connect(member("grace"), broken);
		hub.connect(member("alan"), healthy);

		opened("i-1");
		opened("i-2");
		await flush();

		expect(broken.closed).toBe(true);
		expect(types(healthy)).toEqual(["ready", "incident.opened", "incident.opened"]);
	});

	it("closes a stream when its token expires", async () => {
		const grace = sink();
		hub.connect(member("grace", ACME, new Date(START.getTime() + 60_000)), grace);

		await vi.advanceTimersByTimeAsync(59_999);
		expect(grace.closed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);

		expect(grace.closed).toBe(true);
	});

	it("stops sending to a stream once it is closed by its client", async () => {
		const grace = sink();
		const disconnect = hub.connect(member("grace"), grace);

		disconnect();
		opened("i-1");
		await flush();

		expect(grace.closed).toBe(true);
		expect(types(grace)).toEqual(["ready"]);
	});
});
