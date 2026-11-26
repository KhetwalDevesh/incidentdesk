import type { Pool, PoolClient } from "pg";
import type { PageQuery } from "../../contract/common";
import type {
	AuditAction,
	AuditActor,
	AuditEntry,
	AuditEventReader,
	AuditFilter,
	AuditPage,
	AuditPurger,
	AuditRecorder,
	AuditResource,
	AuditResourceType,
} from "../../domain/audit/types";
import type { TenantId } from "../../domain/shared/identity";

const COLUMNS =
	"tenant_id, id, occurred_at, actor_type, actor_id, action, resource_type, resource_id, details, request_id";

type AuditRow = {
	tenant_id: string;
	id: string;
	occurred_at: Date;
	actor_type: AuditActor["type"];
	actor_id: string | null;
	action: AuditAction;
	resource_type: AuditResourceType;
	resource_id: string;
	details: Record<string, string>;
	request_id: string | null;
};

const toEntry = (row: AuditRow): AuditEntry => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	occurredAt: row.occurred_at,
	action: row.action,
	actor: { type: row.actor_type, id: row.actor_id } as AuditActor,
	resource: { type: row.resource_type, id: row.resource_id },
	details: row.details,
	requestId: row.request_id,
});

// Inserts entries on the caller's client, so they commit or roll back with its change.
export const insertAuditEntries = async (
	db: Pool | PoolClient,
	entries: AuditEntry[],
): Promise<void> => {
	for (const entry of entries) {
		await db.query(
			`INSERT INTO audit_events (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			[
				entry.tenantId,
				entry.id,
				entry.occurredAt,
				entry.actor.type,
				entry.actor.id,
				entry.action,
				entry.resource.type,
				entry.resource.id,
				JSON.stringify(entry.details),
				entry.requestId,
			],
		);
	}
};

// Runs work in one transaction, rolling back on any error.
export const inTransaction = async <T>(
	pool: Pool,
	work: (client: PoolClient) => Promise<T>,
): Promise<T> => {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await work(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
};

const FILTER = `tenant_id = $1
	AND ($2::text IS NULL OR action = $2)
	AND ($3::text IS NULL OR resource_type = $3)
	AND ($4::text IS NULL OR resource_id = $4)
	AND ($5::text IS NULL OR actor_id = $5)
	AND ($6::timestamptz IS NULL OR occurred_at >= $6)
	AND ($7::timestamptz IS NULL OR occurred_at <= $7)`;

export class PostgresAuditRepository implements AuditEventReader, AuditRecorder, AuditPurger {
	constructor(private readonly pool: Pool) {}

	async record(entry: AuditEntry): Promise<void> {
		await insertAuditEntries(this.pool, [entry]);
	}

	async list(
		tenantId: TenantId,
		filter: AuditFilter,
		{ limit, offset }: PageQuery,
	): Promise<AuditPage> {
		const params = [
			tenantId,
			filter.action ?? null,
			filter.resourceType ?? null,
			filter.resourceId ?? null,
			filter.actorId ?? null,
			filter.from ?? null,
			filter.to ?? null,
		];
		const [page, count] = await Promise.all([
			this.pool.query<AuditRow>(
				`SELECT ${COLUMNS} FROM audit_events WHERE ${FILTER}
				ORDER BY occurred_at DESC, seq DESC LIMIT $8 OFFSET $9`,
				[...params, limit, offset],
			),
			this.pool.query<{ total: string }>(
				`SELECT count(*) AS total FROM audit_events WHERE ${FILTER}`,
				params,
			),
		]);
		return { items: page.rows.map(toEntry), total: Number(count.rows[0]?.total ?? 0) };
	}

	async listForResource(
		tenantId: TenantId,
		resource: AuditResource,
		{ limit, offset }: PageQuery,
	): Promise<AuditPage> {
		const filter = "tenant_id = $1 AND resource_type = $2 AND resource_id = $3";
		const [page, count] = await Promise.all([
			this.pool.query<AuditRow>(
				`SELECT ${COLUMNS} FROM audit_events WHERE ${filter}
				ORDER BY occurred_at, seq LIMIT $4 OFFSET $5`,
				[tenantId, resource.type, resource.id, limit, offset],
			),
			this.pool.query<{ total: string }>(
				`SELECT count(*) AS total FROM audit_events WHERE ${filter}`,
				[tenantId, resource.type, resource.id],
			),
		]);
		return { items: page.rows.map(toEntry), total: Number(count.rows[0]?.total ?? 0) };
	}

	// SKIP LOCKED lets several workers purge at once without waiting on each other. The
	// audit_events trigger refuses to delete anything younger than the retention period.
	async purgeOlderThan(cutoff: Date, limit: number): Promise<number> {
		const { rowCount } = await this.pool.query(
			`DELETE FROM audit_events WHERE (tenant_id, id) IN (
				SELECT tenant_id, id FROM audit_events
				WHERE occurred_at < $1
				ORDER BY occurred_at
				LIMIT $2
				FOR UPDATE SKIP LOCKED
			)`,
			[cutoff, limit],
		);
		return rowCount ?? 0;
	}
}
