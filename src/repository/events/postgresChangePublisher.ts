import type { Pool, PoolClient } from "pg";
import type { ChangeNotice } from "../../domain/events/types";

// Spec: docs/features/realtime-status.md

export const CHANGE_CHANNEL = "incidentdesk_changes";

// Queues the notice on the caller's transaction. Postgres delivers it to every listener only
// when that transaction commits, in commit order, and drops it on rollback.
export const publishChange = async (db: Pool | PoolClient, notice: ChangeNotice) => {
	await db.query("SELECT pg_notify($1, $2)", [CHANGE_CHANNEL, JSON.stringify(notice)]);
};
