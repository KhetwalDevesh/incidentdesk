import type { Pool, PoolClient } from "pg";
import type { AlertListQuery } from "../../contract/alerts";
import type { IncidentId } from "../../contract/incidents";
import type {
	Alert,
	AlertOutbox,
	AlertPage,
	AlertRef,
	AlertRepository,
	GroupingOutcome,
} from "../../domain/alerts/types";
import type { AuditEntry } from "../../domain/audit/types";
import type { Incident } from "../../domain/incidents/types";
import type { DeliveryNotice } from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";
import type { DraftRequest } from "../../domain/summaries/types";
import { insertAuditEntries } from "../audit/postgresAuditRepository";
import { publishChange } from "../events/postgresChangePublisher";
import {
	INCIDENT_COLUMNS,
	INCIDENT_PLACEHOLDERS,
	incidentValues,
} from "../incidents/postgresIncidentRepository";
import { insertDeliveries } from "../notifications/postgresNotificationDeliveryRepository";
import { insertDraft } from "../summaries/postgresSummaryDraftRepository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS =
	"id, tenant_id, source_id, dedup_key, title, severity, alert_status, details, received_at, state, attempts, next_attempt_at, last_error, incident_id, processed_at, sent_at";

type AlertRow = {
	id: string;
	tenant_id: string;
	source_id: string;
	dedup_key: string;
	title: string;
	severity: Alert["severity"];
	alert_status: Alert["status"];
	details: Alert["details"];
	received_at: Date;
	state: Alert["state"];
	attempts: number;
	next_attempt_at: Date;
	last_error: string | null;
	incident_id: string | null;
	processed_at: Date | null;
	sent_at: Date | null;
};

const toAlert = (row: AlertRow): Alert => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	sourceId: row.source_id,
	dedupKey: row.dedup_key,
	status: row.alert_status,
	title: row.title,
	severity: row.severity,
	details: row.details,
	state: row.state,
	attempts: row.attempts,
	nextAttemptAt: row.next_attempt_at,
	lastError: row.last_error,
	incidentId: row.incident_id as IncidentId | null,
	receivedAt: row.received_at,
	processedAt: row.processed_at,
	sentAt: row.sent_at,
});

// Opens the candidate, or attaches to the unresolved incident for its source and key.
// The partial unique index incidents_unresolved_group_key arbitrates, so concurrent
// workers that see the same new key end with one incident.
const OPEN_OR_ATTACH = `INSERT INTO incidents (${INCIDENT_COLUMNS})
	VALUES (${INCIDENT_PLACEHOLDERS})
	ON CONFLICT (tenant_id, alert_source_id, dedup_key) WHERE status <> 'resolved'
	DO UPDATE SET alert_count = incidents.alert_count + 1,
		last_alert_at = GREATEST(incidents.last_alert_at, EXCLUDED.last_alert_at)
	RETURNING id, (xmax = 0) AS opened`;

const ATTACH_ONLY = `UPDATE incidents SET alert_count = alert_count + 1,
		last_alert_at = GREATEST(last_alert_at, $4)
	WHERE tenant_id = $1 AND alert_source_id = $2 AND dedup_key = $3 AND status <> 'resolved'
	RETURNING id, false AS opened`;

export class PostgresAlertRepository implements AlertRepository, AlertOutbox {
	constructor(private readonly pool: Pool) {}

	async enqueue(tenantId: TenantId, alert: Omit<Alert, "tenantId">): Promise<Alert> {
		const { rows } = await this.pool.query<AlertRow>(
			`INSERT INTO alerts (${COLUMNS})
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING ${COLUMNS}`,
			[
				alert.id,
				tenantId,
				alert.sourceId,
				alert.dedupKey,
				alert.title,
				alert.severity,
				alert.status,
				JSON.stringify(alert.details),
				alert.receivedAt,
				alert.state,
				alert.attempts,
				alert.nextAttemptAt,
				alert.lastError,
				alert.incidentId,
				alert.processedAt,
				alert.sentAt,
			],
		);
		return toAlert(rows[0] as AlertRow);
	}

	async list(tenantId: TenantId, { limit, offset, state }: AlertListQuery): Promise<AlertPage> {
		const filter = "tenant_id = $1 AND ($2::text IS NULL OR state = $2)";
		const [page, count] = await Promise.all([
			this.pool.query<AlertRow>(
				`SELECT ${COLUMNS} FROM alerts WHERE ${filter} ORDER BY received_at DESC, id LIMIT $3 OFFSET $4`,
				[tenantId, state ?? null, limit, offset],
			),
			this.pool.query<{ total: string }>(`SELECT count(*) AS total FROM alerts WHERE ${filter}`, [
				tenantId,
				state ?? null,
			]),
		]);
		return { items: page.rows.map(toAlert), total: Number(count.rows[0]?.total ?? 0) };
	}

	async markSent(tenantId: TenantId, alertId: string, sentAt: Date): Promise<void> {
		await this.pool.query("UPDATE alerts SET sent_at = $3 WHERE tenant_id = $1 AND id = $2", [
			tenantId,
			alertId,
			sentAt,
		]);
	}

	async startAttempt(tenantId: TenantId, alertId: string, leaseUntil: Date): Promise<Alert | null> {
		const { rows } = await this.pool.query<AlertRow>(
			`UPDATE alerts SET attempts = attempts + 1, next_attempt_at = $3
			WHERE tenant_id = $1 AND id = $2 AND state = 'pending'
			RETURNING ${COLUMNS}`,
			[tenantId, alertId, leaseUntil],
		);
		return rows[0] ? toAlert(rows[0]) : null;
	}

	// SKIP LOCKED lets concurrent sweepers claim disjoint rows. Moving next_attempt_at to now
	// keeps a claimed row out of later claims after this statement's locks are released.
	async claimOverdue(
		{ unsentBefore, sentBefore }: { unsentBefore: Date; sentBefore: Date },
		now: Date,
		limit: number,
	): Promise<AlertRef[]> {
		const { rows } = await this.pool.query<{ tenant_id: string; id: string; received_at: Date }>(
			`UPDATE alerts SET next_attempt_at = $3
			WHERE (tenant_id, id) IN (
				SELECT tenant_id, id FROM alerts
				WHERE state = 'pending'
					-- A plain range, so alerts_pending_due_idx can serve the scan.
					AND next_attempt_at <= GREATEST($1::timestamptz, $2::timestamptz)
					AND next_attempt_at <= CASE WHEN sent_at IS NULL THEN $1::timestamptz ELSE $2::timestamptz END
				ORDER BY received_at, id
				LIMIT $4
				FOR UPDATE SKIP LOCKED
			)
			RETURNING tenant_id, id, received_at`,
			[unsentBefore, sentBefore, now, limit],
		);
		return rows
			.sort(
				(a, b) =>
					a.received_at.getTime() - b.received_at.getTime() ||
					(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			)
			.map((row) => ({ tenantId: row.tenant_id as TenantId, alertId: row.id }));
	}

	async complete(
		tenantId: TenantId,
		alertId: string,
		candidate: Omit<Incident, "tenantId"> | null,
		processedAt: Date,
		audit: (outcome: GroupingOutcome) => AuditEntry[],
		notice?: (outcome: GroupingOutcome) => DeliveryNotice | null,
		draft?: (outcome: GroupingOutcome) => DraftRequest | null,
	): Promise<{ incidentId: IncidentId | null } | null> {
		return this.transaction(async (client) => {
			// Locks the alert, so a second worker holding an expired lease waits, then sees it processed.
			const locked = await client.query<AlertRow>(
				`SELECT ${COLUMNS} FROM alerts WHERE tenant_id = $1 AND id = $2 AND state = 'pending' FOR UPDATE`,
				[tenantId, alertId],
			);
			const alert = locked.rows[0];
			if (!alert) return null;

			const grouped = candidate
				? await client.query<{ id: string; opened: boolean }>(
						OPEN_OR_ATTACH,
						incidentValues(tenantId, {
							...candidate,
							alertSourceId: alert.source_id,
							dedupKey: alert.dedup_key,
							lastAlertAt: alert.received_at,
						}),
					)
				: await client.query<{ id: string; opened: boolean }>(ATTACH_ONLY, [
						tenantId,
						alert.source_id,
						alert.dedup_key,
						alert.received_at,
					]);
			const incidentId = (grouped.rows[0]?.id ?? null) as IncidentId | null;
			// xmax is 0 only for a row this statement inserted, so the candidate opened it.
			const opened = grouped.rows[0]?.opened ?? false;

			await client.query(
				`UPDATE alerts SET state = 'processed', incident_id = $3, last_error = NULL, processed_at = $4
				WHERE tenant_id = $1 AND id = $2`,
				[tenantId, alertId, incidentId, processedAt],
			);
			await insertAuditEntries(client, audit({ incidentId, opened }));
			const deliveries = notice?.({ incidentId, opened });
			if (deliveries) await insertDeliveries(client, tenantId, deliveries);
			const summary = draft?.({ incidentId, opened });
			if (summary) await insertDraft(client, tenantId, summary);
			if (opened && incidentId) {
				await publishChange(client, {
					kind: "incident",
					tenantId,
					id: incidentId,
					event: "incident.opened",
				});
			}
			return { incidentId };
		});
	}

	async listForIncident(
		tenantId: TenantId,
		incidentId: IncidentId,
		limit: number,
	): Promise<Alert[]> {
		// Alerts key tenants by uuid, so a tenant whose id is not one has no alerts.
		if (!UUID.test(tenantId)) return [];
		const { rows } = await this.pool.query<AlertRow>(
			`SELECT ${COLUMNS} FROM alerts WHERE tenant_id = $1 AND incident_id = $2
			ORDER BY received_at DESC, id LIMIT $3`,
			[tenantId, incidentId, limit],
		);
		return rows.map(toAlert);
	}

	async fail(
		tenantId: TenantId,
		alertId: string,
		error: string,
		retryAt: Date | null,
		now: Date,
	): Promise<void> {
		await this.pool.query(
			`UPDATE alerts SET last_error = $3,
				state = CASE WHEN $4::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
				next_attempt_at = COALESCE($4::timestamptz, next_attempt_at),
				processed_at = CASE WHEN $4::timestamptz IS NULL THEN $5::timestamptz ELSE NULL END
			WHERE tenant_id = $1 AND id = $2 AND state = 'pending'`,
			[tenantId, alertId, error, retryAt, now],
		);
	}

	private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
		const client = await this.pool.connect();
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
	}
}
