import { Client, type ClientConfig } from "pg";
import { z } from "zod";
import type { ChangeFeed, ChangeNotice, FeedItem } from "../domain/events/types";
import { CHANGE_CHANNEL } from "../repository/events/postgresChangePublisher";

// Spec: docs/features/realtime-status.md. One dedicated connection per API instance LISTENs
// for committed change notices. If it drops, notices may be missed, so after every
// reconnect it emits a resync and clients refetch.

export const LISTEN_BACKOFF_MS = [1000, 2000, 5000, 10_000] as const;

const Id = z.string().min(1).max(200);

const NoticeSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("incident"),
		tenantId: Id,
		id: Id,
		event: z.enum([
			"incident.opened",
			"incident.acknowledged",
			"incident.resolved",
			"incident.reassigned",
			"incident.updated",
		]),
	}),
	z.object({
		kind: z.literal("on_call_schedule"),
		tenantId: Id,
		id: Id,
		event: z.enum([
			"on_call_schedule.created",
			"on_call_schedule.updated",
			"on_call_schedule.deleted",
		]),
	}),
	z.object({
		kind: z.literal("on_call_override"),
		tenantId: Id,
		scheduleId: Id,
		id: Id,
		event: z.enum(["on_call_override.created", "on_call_override.deleted"]),
	}),
	z.object({ kind: z.literal("members_removed"), tenantId: Id, userIds: z.array(Id).max(50) }),
	z.object({ kind: z.literal("summary_draft"), tenantId: Id, incidentId: Id, id: Id }),
]);

// Notices come from our own transactions, but are parsed as untrusted all the same.
export const parseNotice = (payload: string | undefined): ChangeNotice | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload ?? "");
	} catch {
		return null;
	}
	const result = NoticeSchema.safeParse(parsed);
	return result.success ? (result.data as ChangeNotice) : null;
};

export type PgChangeFeed = ChangeFeed & { close(): Promise<void> };

export const createPgChangeFeed = (
	config: ClientConfig,
	// Gets a fixed description, never a payload.
	onError: (subject: string, error: unknown) => void = () => undefined,
): PgChangeFeed => {
	const listeners = new Set<(item: FeedItem) => void>();
	const emit = (item: FeedItem) => {
		for (const listener of listeners) listener(item);
	};
	let client: Client | null = null;
	let stopped = false;
	let failures = 0;
	let retry: ReturnType<typeof setTimeout> | null = null;

	const reconnectLater = () => {
		if (stopped || retry) return;
		const delay = LISTEN_BACKOFF_MS[Math.min(failures, LISTEN_BACKOFF_MS.length - 1)];
		failures += 1;
		retry = setTimeout(() => {
			retry = null;
			void connect();
		}, delay);
	};

	const connect = async () => {
		const next = new Client(config);
		client = next;
		next.on("notification", (message) => {
			if (message.channel !== CHANGE_CHANNEL) return;
			const notice = parseNotice(message.payload);
			if (notice) emit(notice);
			else onError("change notice", new Error("malformed change notice"));
		});
		const lost = (error?: unknown) => {
			if (client !== next) return;
			client = null;
			if (error) onError("change feed", error);
			void next.end().catch(() => undefined);
			reconnectLater();
		};
		next.on("error", lost);
		next.on("end", () => lost());
		try {
			await next.connect();
			await next.query(`LISTEN ${CHANGE_CHANNEL}`);
			failures = 0;
			// Anything committed while no connection was listening is lost: clients refetch.
			emit({ kind: "resync" });
		} catch (error) {
			lost(error);
		}
	};

	void connect();

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async close() {
			stopped = true;
			if (retry) clearTimeout(retry);
			const current = client;
			client = null;
			await current?.end().catch(() => undefined);
		},
	};
};
