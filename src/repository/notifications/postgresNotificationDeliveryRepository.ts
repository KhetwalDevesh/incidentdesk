import type { Pool, PoolClient } from "pg";
import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type {
	AttemptStart,
	DeliveryFailureReason,
	DeliveryNotice,
	DeliveryOutbox,
	DeliveryPurger,
	DeliveryRef,
	NotificationDelivery,
	NotificationDeliveryPage,
	NotificationDeliveryRepository,
	NotificationEvent,
} from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";

// Spec: docs/features/slack-delivery.md

const COLUMNS =
	"tenant_id, id, channel_id, incident_id, event, occurrence, payload, state, attempts, next_attempt_at, sent_at, failure_reason, last_status, last_error, created_at, delivered_at";

type DeliveryRow = {
	tenant_id: string;
	id: string;
	channel_id: string;
	incident_id: string;
	event: NotificationDelivery["event"];
	occurrence: number;
	payload: NotificationDelivery["payload"];
	state: NotificationDelivery["state"];
	attempts: number;
	next_attempt_at: Date;
	sent_at: Date | null;
	failure_reason: DeliveryFailureReason | null;
	last_status: number | null;
	last_error: string | null;
	created_at: Date;
	delivered_at: Date | null;
};

const toDelivery = (row: DeliveryRow): NotificationDelivery => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	channelId: row.channel_id,
	incidentId: row.incident_id as IncidentId,
	event: row.event,
	occurrence: row.occurrence,
	payload: row.payload,
	state: row.state,
	attempts: row.attempts,
	nextAttemptAt: row.next_attempt_at,
	sentAt: row.sent_at,
	failureReason: row.failure_reason,
	lastStatus: row.last_status,
	lastError: row.last_error,
	createdAt: row.created_at,
	deliveredAt: row.delivered_at,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Removes the actor's and the assignee's emails once a delivery is no longer pending. Each is a
// no-op where the key is missing: an alert source actor, or an unassigned or older payload.
const WITHOUT_EMAIL =
	"jsonb_set(jsonb_set(payload, '{actor,email}', 'null'::jsonb, false), '{assignee,email}', 'null'::jsonb, false)";

// Writes one pending delivery per enabled channel whose minimum severity the incident meets,
// on the caller's client, so they commit or roll back with the incident change.
export const insertDeliveries = async (
	db: Pool | PoolClient,
	tenantId: TenantId,
	notice: DeliveryNotice,
): Promise<void> => {
	// incidents.tenant_id is still text (see migration 0002), but channels key tenants by uuid,
	// so a tenant whose id is not a uuid has no channels.
	if (!UUID.test(tenantId)) return;
	// 'sev1' < 'sev4' as text, so min_severity >= severity means the incident is severe enough.
	// The unique event key makes a repeated notice a no-op.
	await db.query(
		`INSERT INTO notification_deliveries
			(tenant_id, id, channel_id, incident_id, event, occurrence, payload, state, attempts, next_attempt_at, created_at)
		SELECT tenant_id, gen_random_uuid(), id, $2, $3, $7, $4::jsonb, 'pending', 0, $5, $5
		FROM notification_channels
		WHERE tenant_id = $1 AND enabled AND min_severity >= $6
		ON CONFLICT (tenant_id, channel_id, incident_id, event, occurrence) DO NOTHING`,
		[
			tenantId,
			notice.incidentId,
			notice.event,
			JSON.stringify(notice.payload),
			notice.createdAt,
			notice.severity,
			notice.occurrence ?? 0,
		],
	);
};

export class PostgresNotificationDeliveryRepository
	implements NotificationDeliveryRepository, DeliveryOutbox, DeliveryPurger
{
	constructor(private readonly pool: Pool) {}

	async listUnsent(
		tenantId: TenantId,
		incidentId: IncidentId,
		event: NotificationEvent,
	): Promise<DeliveryRef[]> {
		if (!UUID.test(tenantId)) return [];
		const { rows } = await this.pool.query<{ id: string }>(
			`SELECT id FROM notification_deliveries
			WHERE tenant_id = $1 AND incident_id = $2 AND event = $3 AND state = 'pending' AND sent_at IS NULL
			ORDER BY created_at, id
			LIMIT 1000`,
			[tenantId, incidentId, event],
		);
		return rows.map((row) => ({ tenantId, deliveryId: row.id }));
	}

	async markSent(tenantId: TenantId, deliveryId: string, sentAt: Date): Promise<void> {
		await this.pool.query(
			"UPDATE notification_deliveries SET sent_at = $3 WHERE tenant_id = $1 AND id = $2",
			[tenantId, deliveryId, sentAt],
		);
	}

	async startAttempt(
		tenantId: TenantId,
		deliveryId: string,
		now: Date,
		leaseUntil: Date,
	): Promise<AttemptStart> {
		const { rows } = await this.pool.query<DeliveryRow>(
			`UPDATE notification_deliveries SET attempts = attempts + 1, next_attempt_at = $4
			WHERE tenant_id = $1 AND id = $2 AND state = 'pending' AND next_attempt_at <= $3
			RETURNING ${COLUMNS}`,
			[tenantId, deliveryId, now, leaseUntil],
		);
		if (rows[0]) return { status: "started", delivery: toDelivery(rows[0]) };
		const held = await this.pool.query<{ next_attempt_at: Date }>(
			`SELECT next_attempt_at FROM notification_deliveries
			WHERE tenant_id = $1 AND id = $2 AND state = 'pending'`,
			[tenantId, deliveryId],
		);
		return held.rows[0] ? { status: "leased", until: held.rows[0].next_attempt_at } : null;
	}

	async deliver(tenantId: TenantId, deliveryId: string, status: number, at: Date): Promise<void> {
		await this.pool.query(
			`UPDATE notification_deliveries SET state = 'delivered', delivered_at = $4, last_status = $3,
				last_error = NULL, payload = ${WITHOUT_EMAIL}
			WHERE tenant_id = $1 AND id = $2 AND state = 'pending'`,
			[tenantId, deliveryId, status, at],
		);
	}

	async retry(
		tenantId: TenantId,
		deliveryId: string,
		{
			retryAt,
			counted,
			status,
			error,
		}: { retryAt: Date; counted: boolean; status: number | null; error: string },
	): Promise<void> {
		await this.pool.query(
			`UPDATE notification_deliveries SET next_attempt_at = $3, last_status = $4, last_error = $5,
				attempts = CASE WHEN $6::boolean THEN attempts ELSE GREATEST(attempts - 1, 0) END
			WHERE tenant_id = $1 AND id = $2 AND state = 'pending'`,
			[tenantId, deliveryId, retryAt, status, error, counted],
		);
	}

	async fail(
		tenantId: TenantId,
		deliveryId: string,
		{
			reason,
			status,
			error,
		}: { reason: DeliveryFailureReason; status: number | null; error: string },
	): Promise<void> {
		await this.pool.query(
			`UPDATE notification_deliveries SET state = 'failed', failure_reason = $3, last_status = $4,
				last_error = $5, payload = ${WITHOUT_EMAIL}
			WHERE tenant_id = $1 AND id = $2 AND state = 'pending'`,
			[tenantId, deliveryId, reason, status, error],
		);
	}

	async listForChannel(
		tenantId: TenantId,
		channelId: string,
		{ limit, offset }: PageQuery,
	): Promise<NotificationDeliveryPage> {
		const [page, count] = await Promise.all([
			this.pool.query<DeliveryRow>(
				`SELECT ${COLUMNS} FROM notification_deliveries WHERE tenant_id = $1 AND channel_id = $2
				ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
				[tenantId, channelId, limit, offset],
			),
			this.pool.query<{ total: string }>(
				"SELECT count(*) AS total FROM notification_deliveries WHERE tenant_id = $1 AND channel_id = $2",
				[tenantId, channelId],
			),
		]);
		return { items: page.rows.map(toDelivery), total: Number(count.rows[0]?.total ?? 0) };
	}

	// The twin of PostgresAlertRepository.claimOverdue. SKIP LOCKED lets sweepers run side by side.
	async claimOverdue(
		{ unsentBefore, sentBefore }: { unsentBefore: Date; sentBefore: Date },
		now: Date,
		limit: number,
	): Promise<DeliveryRef[]> {
		const { rows } = await this.pool.query<{ tenant_id: string; id: string; created_at: Date }>(
			`UPDATE notification_deliveries SET next_attempt_at = $3
			WHERE (tenant_id, id) IN (
				SELECT tenant_id, id FROM notification_deliveries
				WHERE state = 'pending'
					-- A plain range, so notification_deliveries_pending_due_idx can serve the scan.
					AND next_attempt_at <= GREATEST($1::timestamptz, $2::timestamptz)
					AND next_attempt_at <= CASE WHEN sent_at IS NULL THEN $1::timestamptz ELSE $2::timestamptz END
				ORDER BY created_at, id
				LIMIT $4
				FOR UPDATE SKIP LOCKED
			)
			RETURNING tenant_id, id, created_at`,
			[unsentBefore, sentBefore, now, limit],
		);
		return rows
			.sort(
				(a, b) =>
					a.created_at.getTime() - b.created_at.getTime() ||
					(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			)
			.map((row) => ({ tenantId: row.tenant_id as TenantId, deliveryId: row.id }));
	}

	async purgeOlderThan(cutoff: Date, limit: number): Promise<number> {
		const { rowCount } = await this.pool.query(
			`DELETE FROM notification_deliveries WHERE (tenant_id, id) IN (
				SELECT tenant_id, id FROM notification_deliveries
				WHERE created_at < $1
				ORDER BY created_at
				LIMIT $2
				FOR UPDATE SKIP LOCKED
			)`,
			[cutoff, limit],
		);
		return rowCount ?? 0;
	}
}
