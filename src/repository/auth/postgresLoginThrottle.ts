import type { Pool } from "pg";
import type { LoginThrottle, ThrottleOutcome, ThrottleRule } from "../../domain/auth/types";
import { inTransaction } from "../audit/postgresAuditRepository";

// Spec: docs/features/login-rate-limiting.md. Global keys: these routes run before any tenant
// is known.

// One statement counts the event. The conflicting row is locked for its update, so concurrent
// events on one key queue and each one counts. Parameters: $1 key, $2 now, $3 window in ms,
// $4 limit, $5 lock in ms.
const EXPIRED =
	"auth_throttle.window_started_at <= $2::timestamptz - $3 * interval '1 millisecond'";
const NEXT_COUNT = `CASE WHEN ${EXPIRED} THEN 1 ELSE auth_throttle.count + 1 END`;
const LOCK_END = "$2::timestamptz + $5 * interval '1 millisecond'";

const RECORD = `INSERT INTO auth_throttle AS auth_throttle
		(key, window_started_at, count, locked_until, updated_at)
	VALUES ($1, $2, 1, CASE WHEN 1 >= $4 THEN ${LOCK_END} END, $2)
	ON CONFLICT (key) DO UPDATE SET
		window_started_at = CASE WHEN ${EXPIRED} THEN $2 ELSE auth_throttle.window_started_at END,
		count = ${NEXT_COUNT},
		-- A lock in force stays as it is. Otherwise reaching the limit starts one now.
		locked_until = CASE
			WHEN auth_throttle.locked_until > $2 THEN auth_throttle.locked_until
			WHEN ${NEXT_COUNT} >= $4 THEN ${LOCK_END}
		END,
		updated_at = $2
	RETURNING count, locked_until`;

export class PostgresLoginThrottle implements LoginThrottle {
	constructor(private readonly pool: Pool) {}

	async lockedUntil(keys: string[], now: Date): Promise<Date | null> {
		const { rows } = await this.pool.query<{ until: Date | null }>(
			"SELECT max(locked_until) AS until FROM auth_throttle WHERE key = ANY($1) AND locked_until > $2",
			[keys, now],
		);
		return rows[0]?.until ?? null;
	}

	// The lock in force before this event is read under the row's lock in the same transaction,
	// so exactly one of many concurrent events reports starting a lock. A key with no row yet
	// had no lock: two first events both read nothing, and the upsert serialises their counts.
	async record(key: string, rule: ThrottleRule, now: Date): Promise<ThrottleOutcome> {
		return inTransaction(this.pool, async (client) => {
			const before = await client.query<{ locked_until: Date | null }>(
				"SELECT locked_until FROM auth_throttle WHERE key = $1 FOR UPDATE",
				[key],
			);
			const previous = before.rows[0]?.locked_until ?? null;
			const { rows } = await client.query<{ count: number; locked_until: Date | null }>(RECORD, [
				key,
				now,
				rule.windowMs,
				rule.limit,
				rule.lockMs,
			]);
			const lockedUntil = rows[0]?.locked_until ?? null;
			return {
				count: rows[0]?.count ?? 0,
				lockedUntil,
				lockedNow: lockedUntil !== null && (previous === null || previous <= now),
			};
		});
	}

	async clear(key: string): Promise<void> {
		await this.pool.query("DELETE FROM auth_throttle WHERE key = $1", [key]);
	}

	async purgeOlderThan(cutoff: Date, limit: number): Promise<number> {
		const { rowCount } = await this.pool.query(
			`DELETE FROM auth_throttle WHERE key IN (
				SELECT key FROM auth_throttle
				WHERE updated_at < $1 AND (locked_until IS NULL OR locked_until < $1)
				LIMIT $2
			)`,
			[cutoff, limit],
		);
		return rowCount ?? 0;
	}
}
