import type { Pool } from "pg";
import type { PageQuery } from "../../contract/common";
import type {
	AlertSource,
	AlertSourceLookup,
	AlertSourcePage,
	AlertSourceRepository,
} from "../../domain/alerts/types";
import type { TenantId } from "../../domain/shared/identity";

const COLUMNS = "id, tenant_id, name, secret_ciphertext, secret_hint, created_at";

type SourceRow = {
	id: string;
	tenant_id: string;
	name: string;
	secret_ciphertext: Buffer;
	secret_hint: string;
	created_at: Date;
};

const toSource = (row: SourceRow): AlertSource => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	name: row.name,
	secretCiphertext: row.secret_ciphertext,
	secretHint: row.secret_hint,
	createdAt: row.created_at,
});

export class PostgresAlertSourceRepository implements AlertSourceRepository, AlertSourceLookup {
	constructor(private readonly pool: Pool) {}

	async create(
		tenantId: TenantId,
		source: Omit<AlertSource, "tenantId">,
	): Promise<AlertSource | null> {
		// The unique (tenant_id, name) index decides a duplicate, even under concurrent creates.
		const { rows } = await this.pool.query<SourceRow>(
			`INSERT INTO alert_sources (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (tenant_id, name) DO NOTHING RETURNING ${COLUMNS}`,
			[
				source.id,
				tenantId,
				source.name,
				Buffer.from(source.secretCiphertext),
				source.secretHint,
				source.createdAt,
			],
		);
		return rows[0] ? toSource(rows[0]) : null;
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
