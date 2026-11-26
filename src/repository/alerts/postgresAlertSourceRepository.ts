import { DatabaseError, type Pool } from "pg";
import type { PageQuery } from "../../contract/common";
import type {
	AlertSource,
	AlertSourceLookup,
	AlertSourcePage,
	AlertSourceRepository,
	AlertSourceWriteOutcome,
} from "../../domain/alerts/types";
import type { AuditEntry } from "../../domain/audit/types";
import type { TenantId } from "../../domain/shared/identity";
import { insertAuditEntries, inTransaction } from "../audit/postgresAuditRepository";

const COLUMNS =
	"id, tenant_id, name, secret_ciphertext, secret_hint, on_call_schedule_id, created_at";

// The composite foreign key to on_call_schedules: the schedule is not one of the tenant's.
const SCHEDULE_FKEY = "alert_sources_on_call_schedule_fkey";

const isScheduleMissing = (error: unknown) =>
	error instanceof DatabaseError && error.code === "23503" && error.constraint === SCHEDULE_FKEY;

type SourceRow = {
	id: string;
	tenant_id: string;
	name: string;
	secret_ciphertext: Buffer;
	secret_hint: string;
	on_call_schedule_id: string | null;
	created_at: Date;
};

const toSource = (row: SourceRow): AlertSource => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	name: row.name,
	secretCiphertext: row.secret_ciphertext,
	secretHint: row.secret_hint,
	onCallScheduleId: row.on_call_schedule_id,
	createdAt: row.created_at,
});

export class PostgresAlertSourceRepository implements AlertSourceRepository, AlertSourceLookup {
	constructor(private readonly pool: Pool) {}

	async create(
		tenantId: TenantId,
		source: Omit<AlertSource, "tenantId">,
		audit: AuditEntry,
	): Promise<AlertSourceWriteOutcome> {
		// The unique (tenant_id, name) index decides a duplicate, even under concurrent creates.
		// The schedule foreign key decides whether the schedule is the tenant's.
		try {
			return await inTransaction(this.pool, async (client): Promise<AlertSourceWriteOutcome> => {
				const { rows } = await client.query<SourceRow>(
					`INSERT INTO alert_sources (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)
				ON CONFLICT (tenant_id, name) DO NOTHING RETURNING ${COLUMNS}`,
					[
						source.id,
						tenantId,
						source.name,
						Buffer.from(source.secretCiphertext),
						source.secretHint,
						source.onCallScheduleId,
						source.createdAt,
					],
				);
				if (!rows[0]) return { status: "name_taken" };
				await insertAuditEntries(client, [audit]);
				return { status: "saved", source: toSource(rows[0]) };
			});
		} catch (error) {
			if (isScheduleMissing(error)) return { status: "schedule_not_found" };
			throw error;
		}
	}

	async link(
		tenantId: TenantId,
		id: string,
		onCallScheduleId: string | null,
		audit: AuditEntry,
	): Promise<AlertSourceWriteOutcome> {
		try {
			return await inTransaction(this.pool, async (client): Promise<AlertSourceWriteOutcome> => {
				const { rows } = await client.query<SourceRow>(
					`UPDATE alert_sources SET on_call_schedule_id = $3 WHERE tenant_id = $1 AND id = $2
				RETURNING ${COLUMNS}`,
					[tenantId, id, onCallScheduleId],
				);
				if (!rows[0]) return { status: "not_found" };
				await insertAuditEntries(client, [audit]);
				return { status: "saved", source: toSource(rows[0]) };
			});
		} catch (error) {
			if (isScheduleMissing(error)) return { status: "schedule_not_found" };
			throw error;
		}
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery): Promise<AlertSourcePage> {
		const [page, count] = await Promise.all([
			this.pool.query<SourceRow>(
				`SELECT ${COLUMNS} FROM alert_sources WHERE tenant_id = $1 ORDER BY created_at, id LIMIT $2 OFFSET $3`,
				[tenantId, limit, offset],
			),
			this.pool.query<{ total: string }>(
				"SELECT count(*) AS total FROM alert_sources WHERE tenant_id = $1",
				[tenantId],
			),
		]);
		return { items: page.rows.map(toSource), total: Number(count.rows[0]?.total ?? 0) };
	}

	async findForIngest(sourceId: string): Promise<AlertSource | null> {
		const { rows } = await this.pool.query<SourceRow>(
			`SELECT ${COLUMNS} FROM alert_sources WHERE id = $1`,
			[sourceId],
		);
		return rows[0] ? toSource(rows[0]) : null;
	}
}
