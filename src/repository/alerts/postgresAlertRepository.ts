import type { Pool, PoolClient } from "pg";
import type { AlertListQuery } from "../../contract/alerts";
import type { IncidentId } from "../../contract/incidents";
import type { Alert, AlertPage, AlertQueue, AlertRepository } from "../../domain/alerts/types";
import type { Incident } from "../../domain/incidents/types";
import type { TenantId } from "../../domain/shared/identity";
import { INCIDENT_COLUMNS } from "../incidents/postgresIncidentRepository";

const COLUMNS =
	"id, tenant_id, source_id, dedup_key, title, severity, alert_status, details, received_at, state, attempts, next_attempt_at, last_error, incident_id, processed_at";

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
});

// Opens the candidate, or attaches to the unresolved incident for its source and key.
// The partial unique index incidents_unresolved_group_key arbitrates, so concurrent
// workers that see the same new key end with one incident.
const OPEN_OR_ATTACH = `INSERT INTO incidents (${INCIDENT_COLUMNS})
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
	ON CONFLICT (tenant_id, alert_source_id, dedup_key) WHERE status <> 'resolved'
	DO UPDATE SET alert_count = incidents.alert_count + 1,
		last_alert_at = GREATEST(incidents.last_alert_at, EXCLUDED.last_alert_at)
	RETURNING id`;

const ATTACH_ONLY = `UPDATE incidents SET alert_count = alert_count + 1,
		last_alert_at = GREATEST(last_alert_at, $4)
	WHERE tenant_id = $1 AND alert_source_id = $2 AND dedup_key = $3 AND status <> 'resolved'
	RETURNING id`;

export class PostgresAlertRepository implements AlertRepository, AlertQueue {
	constructor(private readonly pool: Pool) {}

	async enqueue(tenantId: TenantId, alert: Omit<Alert, "tenantId">): Promise<Alert> {
		const { rows } = await this.pool.query<AlertRow>(
			`INSERT INTO alerts (${COLUMNS})
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING ${COLUMNS}`,
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

	// SKIP LOCKED lets concurrent workers claim disjoint rows. The lease written here keeps
	// a claimed row out of later claims after this statement's locks are released.
	async claimDue(now: Date, limit: number, leaseUntil: Date): Promise<Alert[]> {
		const { rows } = await this.pool.query<AlertRow>(
			`UPDATE alerts SET attempts = attempts + 1, next_attempt_at = $3
			WHERE (tenant_id, id) IN (
				SELECT tenant_id, id FROM alerts
				WHERE state = 'pending' AND next_attempt_at <= $1
				ORDER BY received_at, id
				LIMIT $2
				FOR UPDATE SKIP LOCKED
			)
			RETURNING ${COLUMNS}`,
			[now, limit, leaseUntil],
		);
		return rows
			.map(toAlert)
			.sort(
				(a, b) =>
					a.receivedAt.getTime() - b.receivedAt.getTime() ||
					(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			);
	}

	async complete(
		tenantId: TenantId,
		alertId: string,
		candidate: Omit<Incident, "tenantId"> | null,
		processedAt: Date,
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
				? await client.query<{ id: string }>(OPEN_OR_ATTACH, [
						candidate.id,
						tenantId,
						candidate.title,
						candidate.severity,
						candidate.status,
						candidate.createdAt,
						candidate.createdBy,
						candidate.acknowledgedAt,
						candidate.acknowledgedBy,
						candidate.resolvedAt,
						candidate.resolvedBy,
						alert.source_id,
						alert.dedup_key,
						candidate.alertCount,
						alert.received_at,
					])
				: await client.query<{ id: string }>(ATTACH_ONLY, [
						tenantId,
						alert.source_id,
						alert.dedup_key,
						alert.received_at,
					]);
			const incidentId = (grouped.rows[0]?.id ?? null) as IncidentId | null;

			await client.query(
				`UPDATE alerts SET state = 'processed', incident_id = $3, last_error = NULL, processed_at = $4
				WHERE tenant_id = $1 AND id = $2`,
				[tenantId, alertId, incidentId, processedAt],
			);
			return { incidentId };
		});
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
