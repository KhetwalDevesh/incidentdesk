import type { Pool } from "pg";
import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type {
	Incident,
	IncidentChanges,
	IncidentPage,
	IncidentRepository,
} from "../../domain/incidents/types";
import type { TenantId } from "../../domain/shared/identity";

const COLUMNS =
	"id, tenant_id, title, severity, status, created_at, created_by, acknowledged_at, acknowledged_by";

type IncidentRow = {
	id: string;
	tenant_id: string;
	title: string;
	severity: Incident["severity"];
	status: Incident["status"];
	created_at: Date;
	created_by: string;
	acknowledged_at: Date | null;
	acknowledged_by: string | null;
};

const toIncident = (row: IncidentRow): Incident => ({
	id: row.id as IncidentId,
	tenantId: row.tenant_id as TenantId,
	title: row.title,
	severity: row.severity,
	status: row.status,
	createdAt: row.created_at,
	createdBy: row.created_by,
	acknowledgedAt: row.acknowledged_at,
	acknowledgedBy: row.acknowledged_by,
});

// The only columns update may write. Values always go in as parameters.
const CHANGE_COLUMNS: Record<keyof IncidentChanges, string> = {
	status: "status",
	acknowledgedAt: "acknowledged_at",
	acknowledgedBy: "acknowledged_by",
};
const CHANGE_KEYS = Object.keys(CHANGE_COLUMNS) as (keyof IncidentChanges)[];

export class PostgresIncidentRepository implements IncidentRepository {
	constructor(private readonly pool: Pool) {}

	async create(tenantId: TenantId, incident: Omit<Incident, "tenantId">): Promise<Incident> {
		const { rows } = await this.pool.query<IncidentRow>(
			`INSERT INTO incidents (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
			[
				incident.id,
				tenantId,
				incident.title,
				incident.severity,
				incident.status,
				incident.createdAt,
				incident.createdBy,
				incident.acknowledgedAt,
				incident.acknowledgedBy,
			],
		);
		return toIncident(rows[0] as IncidentRow);
	}

	async findById(tenantId: TenantId, id: IncidentId): Promise<Incident | null> {
		const { rows } = await this.pool.query<IncidentRow>(
			`SELECT ${COLUMNS} FROM incidents WHERE tenant_id = $1 AND id = $2`,
			[tenantId, id],
		);
		return rows[0] ? toIncident(rows[0]) : null;
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery): Promise<IncidentPage> {
		const [page, count] = await Promise.all([
			this.pool.query<IncidentRow>(
				`SELECT ${COLUMNS} FROM incidents WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
				[tenantId, limit, offset],
			),
			this.pool.query<{ total: string }>(
				"SELECT count(*) AS total FROM incidents WHERE tenant_id = $1",
				[tenantId],
			),
		]);
		return { items: page.rows.map(toIncident), total: Number(count.rows[0]?.total ?? 0) };
	}

	// One statement, so the status check and the write cannot interleave with another request.
	async update(
		tenantId: TenantId,
		id: IncidentId,
		expectedStatus: Incident["status"],
		changes: IncidentChanges,
	): Promise<Incident | null> {
		const keys = CHANGE_KEYS.filter((key) => changes[key] !== undefined);
		const assignments = keys.map((key, index) => `${CHANGE_COLUMNS[key]} = $${index + 4}`);
		const { rows } = await this.pool.query<IncidentRow>(
			`UPDATE incidents SET ${assignments.join(", ") || "status = status"}
			 WHERE tenant_id = $1 AND id = $2 AND status = $3 RETURNING ${COLUMNS}`,
			[tenantId, id, expectedStatus, ...keys.map((key) => changes[key])],
		);
		return rows[0] ? toIncident(rows[0]) : null;
	}
}
