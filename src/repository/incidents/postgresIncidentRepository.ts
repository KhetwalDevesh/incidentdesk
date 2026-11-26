import type { Pool } from "pg";
import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type { AuditEntry } from "../../domain/audit/types";
import type {
	Incident,
	IncidentChanges,
	IncidentPage,
	IncidentRepository,
} from "../../domain/incidents/types";
import type { DeliveryNotice } from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";
import { insertAuditEntries, inTransaction } from "../audit/postgresAuditRepository";
import { insertDeliveries } from "../notifications/postgresNotificationDeliveryRepository";

export const INCIDENT_COLUMNS =
	"id, tenant_id, title, severity, status, created_at, created_by, acknowledged_at, acknowledged_by, resolved_at, resolved_by, alert_source_id, dedup_key, alert_count, last_alert_at";

export type IncidentRow = {
	id: string;
	tenant_id: string;
	title: string;
	severity: Incident["severity"];
	status: Incident["status"];
	created_at: Date;
	created_by: string;
	acknowledged_at: Date | null;
	acknowledged_by: string | null;
	resolved_at: Date | null;
	resolved_by: string | null;
	alert_source_id: string | null;
	dedup_key: string | null;
	alert_count: number;
	last_alert_at: Date | null;
};

export const toIncident = (row: IncidentRow): Incident => ({
	id: row.id as IncidentId,
	tenantId: row.tenant_id as TenantId,
	title: row.title,
	severity: row.severity,
	status: row.status,
	createdAt: row.created_at,
	createdBy: row.created_by,
	acknowledgedAt: row.acknowledged_at,
	acknowledgedBy: row.acknowledged_by,
	resolvedAt: row.resolved_at,
	resolvedBy: row.resolved_by,
	alertSourceId: row.alert_source_id,
	dedupKey: row.dedup_key,
	alertCount: row.alert_count,
	lastAlertAt: row.last_alert_at,
});

// The only columns update may write. Values always go in as parameters.
const CHANGE_COLUMNS: Record<keyof IncidentChanges, string> = {
	status: "status",
	acknowledgedAt: "acknowledged_at",
	acknowledgedBy: "acknowledged_by",
	resolvedAt: "resolved_at",
	resolvedBy: "resolved_by",
};
const CHANGE_KEYS = Object.keys(CHANGE_COLUMNS) as (keyof IncidentChanges)[];

export class PostgresIncidentRepository implements IncidentRepository {
	constructor(private readonly pool: Pool) {}

	async create(
		tenantId: TenantId,
		incident: Omit<Incident, "tenantId">,
		audit: AuditEntry,
		notice?: DeliveryNotice,
	): Promise<Incident> {
		return inTransaction(this.pool, async (client) => {
			const { rows } = await client.query<IncidentRow>(
				`INSERT INTO incidents (${INCIDENT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING ${INCIDENT_COLUMNS}`,
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
					incident.resolvedAt,
					incident.resolvedBy,
					incident.alertSourceId,
					incident.dedupKey,
					incident.alertCount,
					incident.lastAlertAt,
				],
			);
			await insertAuditEntries(client, [audit]);
			if (notice) await insertDeliveries(client, tenantId, notice);
			return toIncident(rows[0] as IncidentRow);
		});
	}

	async findById(tenantId: TenantId, id: IncidentId): Promise<Incident | null> {
		const { rows } = await this.pool.query<IncidentRow>(
			`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE tenant_id = $1 AND id = $2`,
			[tenantId, id],
		);
		return rows[0] ? toIncident(rows[0]) : null;
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery): Promise<IncidentPage> {
		const [page, count] = await Promise.all([
			this.pool.query<IncidentRow>(
				`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
				[tenantId, limit, offset],
			),
			this.pool.query<{ total: string }>(
				"SELECT count(*) AS total FROM incidents WHERE tenant_id = $1",
				[tenantId],
			),
		]);
		return { items: page.rows.map(toIncident), total: Number(count.rows[0]?.total ?? 0) };
	}

	// One statement checks the status and writes, so it cannot interleave with another request.
	// The audit entry joins the same transaction, and only when the update applied.
	async update(
		tenantId: TenantId,
		id: IncidentId,
		expectedStatus: Incident["status"],
		changes: IncidentChanges,
		audit: AuditEntry,
		notice?: DeliveryNotice,
	): Promise<Incident | null> {
		const keys = CHANGE_KEYS.filter((key) => changes[key] !== undefined);
		const assignments = keys.map((key, index) => `${CHANGE_COLUMNS[key]} = $${index + 4}`);
		return inTransaction(this.pool, async (client) => {
			const { rows } = await client.query<IncidentRow>(
				`UPDATE incidents SET ${assignments.join(", ") || "status = status"}
			 WHERE tenant_id = $1 AND id = $2 AND status = $3 RETURNING ${INCIDENT_COLUMNS}`,
				[tenantId, id, expectedStatus, ...keys.map((key) => changes[key])],
			);
			if (!rows[0]) return null;
			await insertAuditEntries(client, [audit]);
			if (notice) await insertDeliveries(client, tenantId, notice);
			return toIncident(rows[0]);
		});
	}
}
