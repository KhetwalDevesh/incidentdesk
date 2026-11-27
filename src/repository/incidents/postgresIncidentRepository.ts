import type { Pool } from "pg";
import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type { AuditEntry } from "../../domain/audit/types";
import { transitionEvent } from "../../domain/events/types";
import type {
	Incident,
	IncidentChanges,
	IncidentExpectation,
	IncidentPage,
	IncidentRepository,
	ReassignOutcome,
	SummaryChange,
} from "../../domain/incidents/types";
import type { DeliveryNotice } from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";
import type { DraftRequest } from "../../domain/summaries/types";
import { insertAuditEntries, inTransaction } from "../audit/postgresAuditRepository";
import { publishChange } from "../events/postgresChangePublisher";
import { insertDeliveries } from "../notifications/postgresNotificationDeliveryRepository";
import { insertDraft } from "../summaries/postgresSummaryDraftRepository";

export const INCIDENT_COLUMNS =
	"id, tenant_id, title, severity, status, created_at, created_by, acknowledged_at, acknowledged_by, resolved_at, resolved_by, alert_source_id, dedup_key, alert_count, last_alert_at, assignee_id, assignment_count, summary, summary_updated_at, summary_updated_by, summary_draft_id";

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
	assignee_id: string | null;
	assignment_count: number;
	summary: string | null;
	summary_updated_at: Date | null;
	summary_updated_by: string | null;
	summary_draft_id: string | null;
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
	assigneeId: row.assignee_id,
	assignmentCount: row.assignment_count,
	summary:
		row.summary !== null && row.summary_updated_at !== null && row.summary_updated_by !== null
			? {
					text: row.summary,
					updatedAt: row.summary_updated_at,
					updatedBy: row.summary_updated_by,
					draftId: row.summary_draft_id,
				}
			: null,
});

// The values for INCIDENT_COLUMNS, in order.
export const incidentValues = (tenantId: TenantId, incident: Omit<Incident, "tenantId">) => [
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
	incident.assigneeId,
	incident.assignmentCount,
	incident.summary?.text ?? null,
	incident.summary?.updatedAt ?? null,
	incident.summary?.updatedBy ?? null,
	incident.summary?.draftId ?? null,
];

// The placeholders for INCIDENT_COLUMNS: $1 to $21.
export const INCIDENT_PLACEHOLDERS = Array.from({ length: 21 }, (_, index) => `$${index + 1}`).join(
	", ",
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
		audit: AuditEntry[],
		notice?: DeliveryNotice,
		draft?: DraftRequest,
	): Promise<Incident> {
		return inTransaction(this.pool, async (client) => {
			const { rows } = await client.query<IncidentRow>(
				`INSERT INTO incidents (${INCIDENT_COLUMNS}) VALUES (${INCIDENT_PLACEHOLDERS}) RETURNING ${INCIDENT_COLUMNS}`,
				incidentValues(tenantId, incident),
			);
			await insertAuditEntries(client, audit);
			if (notice) await insertDeliveries(client, tenantId, notice);
			if (draft) await insertDraft(client, tenantId, draft);
			await publishChange(client, {
				kind: "incident",
				tenantId,
				id: incident.id,
				event: "incident.opened",
			});
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

	// One statement checks the status and assignee and writes, so it cannot interleave with
	// another request. The audit entry joins the same transaction, and only when it applied.
	async update(
		tenantId: TenantId,
		id: IncidentId,
		expected: IncidentExpectation,
		changes: IncidentChanges,
		audit: AuditEntry,
		notice?: DeliveryNotice,
	): Promise<Incident | null> {
		const keys = CHANGE_KEYS.filter((key) => changes[key] !== undefined);
		const assignments = keys.map((key, index) => `${CHANGE_COLUMNS[key]} = $${index + 5}`);
		return inTransaction(this.pool, async (client) => {
			const { rows } = await client.query<IncidentRow>(
				`UPDATE incidents SET ${assignments.join(", ") || "status = status"}
			 WHERE tenant_id = $1 AND id = $2 AND status = $3 AND assignee_id IS NOT DISTINCT FROM $4::uuid
			 RETURNING ${INCIDENT_COLUMNS}`,
				[tenantId, id, expected.status, expected.assigneeId, ...keys.map((key) => changes[key])],
			);
			if (!rows[0]) return null;
			await insertAuditEntries(client, [audit]);
			if (notice) await insertDeliveries(client, tenantId, notice);
			const event = transitionEvent(changes);
			if (event) await publishChange(client, { kind: "incident", tenantId, id, event });
			return toIncident(rows[0]);
		});
	}

	async setSummary(
		tenantId: TenantId,
		id: IncidentId,
		{ summary, severity }: SummaryChange,
		audit: AuditEntry[],
	): Promise<Incident | null> {
		return inTransaction(this.pool, async (client) => {
			const { rows } = await client.query<IncidentRow>(
				`UPDATE incidents SET summary = $3, summary_updated_at = $4, summary_updated_by = $5,
					summary_draft_id = $6, severity = COALESCE($7, severity)
				WHERE tenant_id = $1 AND id = $2
					AND ($7::text IS NULL OR (status <> 'resolved' AND severity = $8))
				RETURNING ${INCIDENT_COLUMNS}`,
				[
					tenantId,
					id,
					summary.text,
					summary.updatedAt,
					summary.updatedBy,
					summary.draftId,
					severity?.to ?? null,
					severity?.from ?? null,
				],
			);
			if (!rows[0]) return null;
			await insertAuditEntries(client, audit);
			await publishChange(client, { kind: "incident", tenantId, id, event: "incident.updated" });
			return toIncident(rows[0]);
		});
	}

	async reassign(
		tenantId: TenantId,
		id: IncidentId,
		{ from, to }: { from: string | null; to: string | null },
		audit: AuditEntry,
		notice: DeliveryNotice,
	): Promise<ReassignOutcome> {
		return inTransaction(this.pool, async (client): Promise<ReassignOutcome> => {
			if (to !== null) {
				// Members key tenants by uuid, so a tenant whose id is not one has no members.
				if (!UUID.test(tenantId) || !UUID.test(to)) return { status: "member_not_found" };
				// FOR SHARE holds the member until commit, so a concurrent removal waits for this
				// reassignment, then unassigns the incident it made.
				const member = await client.query(
					"SELECT id FROM users WHERE tenant_id = $1 AND id = $2 FOR SHARE",
					[tenantId, to],
				);
				if (member.rowCount === 0) return { status: "member_not_found" };
			}
			const { rows } = await client.query<IncidentRow>(
				`UPDATE incidents SET assignee_id = $4, assignment_count = assignment_count + 1
				WHERE tenant_id = $1 AND id = $2 AND status <> 'resolved'
					AND assignee_id IS NOT DISTINCT FROM $3::uuid
				RETURNING ${INCIDENT_COLUMNS}`,
				[tenantId, id, from, to],
			);
			if (!rows[0]) return { status: "changed" };
			const incident = toIncident(rows[0]);
			await insertAuditEntries(client, [audit]);
			await insertDeliveries(client, tenantId, {
				...notice,
				occurrence: incident.assignmentCount,
			});
			await publishChange(client, { kind: "incident", tenantId, id, event: "incident.reassigned" });
			return { status: "reassigned", incident };
		});
	}
}
