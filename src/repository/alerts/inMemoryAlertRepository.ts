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
import type { InMemoryIncidentRepository } from "../incidents/inMemoryIncidentRepository";

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Methods do not await between a check and its write, so each one is atomic like its SQL twin.
export class InMemoryAlertRepository implements AlertRepository, AlertOutbox {
	private readonly alerts = new Map<string, Alert>();

	// Shares the incident store, as the Postgres twin shares the database.
	constructor(private readonly incidents: InMemoryIncidentRepository) {}

	async enqueue(tenantId: TenantId, alert: Omit<Alert, "tenantId">): Promise<Alert> {
		const stored = { ...alert, tenantId };
		this.alerts.set(stored.id, stored);
		return stored;
	}

	async list(tenantId: TenantId, { limit, offset, state }: AlertListQuery): Promise<AlertPage> {
		const owned = [...this.alerts.values()]
			.filter((alert) => alert.tenantId === tenantId && (!state || alert.state === state))
			// Same order as Postgres: newest first, then id.
			.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || compareIds(a.id, b.id));
		return { items: owned.slice(offset, offset + limit), total: owned.length };
	}

	async markSent(tenantId: TenantId, alertId: string, sentAt: Date): Promise<void> {
		const alert = this.alerts.get(alertId);
		if (alert?.tenantId !== tenantId) return;
		this.alerts.set(alertId, { ...alert, sentAt });
	}

	async startAttempt(tenantId: TenantId, alertId: string, leaseUntil: Date): Promise<Alert | null> {
		const alert = this.alerts.get(alertId);
		if (alert?.tenantId !== tenantId || alert.state !== "pending") return null;
		const started = { ...alert, attempts: alert.attempts + 1, nextAttemptAt: leaseUntil };
		this.alerts.set(alertId, started);
		return started;
	}

	async claimOverdue(
		{ unsentBefore, sentBefore }: { unsentBefore: Date; sentBefore: Date },
		now: Date,
		limit: number,
	): Promise<AlertRef[]> {
		const overdue = [...this.alerts.values()]
			.filter(
				(alert) =>
					alert.state === "pending" &&
					alert.nextAttemptAt <= (alert.sentAt === null ? unsentBefore : sentBefore),
			)
			.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || compareIds(a.id, b.id))
			.slice(0, limit);
		return overdue.map((alert) => {
			this.alerts.set(alert.id, { ...alert, nextAttemptAt: now });
			return { tenantId: alert.tenantId, alertId: alert.id };
		});
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
		const alert = this.alerts.get(alertId);
		if (alert?.tenantId !== tenantId || alert.state !== "pending") return null;

		const existing = this.incidents.findUnresolvedGroupSync(
			tenantId,
			alert.sourceId,
			alert.dedupKey,
		);
		const incidentId = existing?.id ?? candidate?.id ?? null;
		const outcome = { incidentId, opened: !existing && candidate !== null };
		const entries = audit(outcome);
		const deliveries = notice?.(outcome) ?? null;
		const summary = draft?.(outcome) ?? null;
		this.incidents.audit.checkSync(entries);
		if (existing) {
			this.incidents.putSync({
				...existing,
				alertCount: existing.alertCount + 1,
				lastAlertAt:
					existing.lastAlertAt && existing.lastAlertAt > alert.receivedAt
						? existing.lastAlertAt
						: alert.receivedAt,
			});
		} else if (candidate) {
			this.incidents.putSync({ ...candidate, tenantId });
		}
		this.incidents.audit.appendSync(entries);
		if (deliveries) this.incidents.deliveries.insertSync(tenantId, deliveries);
		if (summary) this.incidents.drafts.insertSync(tenantId, summary);
		if (outcome.opened && incidentId) {
			this.incidents.feed.publishSync({
				kind: "incident",
				tenantId,
				id: incidentId,
				event: "incident.opened",
			});
		}

		this.alerts.set(alertId, {
			...alert,
			state: "processed",
			incidentId,
			lastError: null,
			processedAt,
		});
		return { incidentId };
	}

	async listForIncident(
		tenantId: TenantId,
		incidentId: IncidentId,
		limit: number,
	): Promise<Alert[]> {
		return [...this.alerts.values()]
			.filter((alert) => alert.tenantId === tenantId && alert.incidentId === incidentId)
			.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || compareIds(a.id, b.id))
			.slice(0, limit);
	}

	async fail(
		tenantId: TenantId,
		alertId: string,
		error: string,
		retryAt: Date | null,
		now: Date,
	): Promise<void> {
		const alert = this.alerts.get(alertId);
		if (alert?.tenantId !== tenantId || alert.state !== "pending") return;
		this.alerts.set(alertId, {
			...alert,
			lastError: error,
			...(retryAt ? { nextAttemptAt: retryAt } : { state: "failed" as const, processedAt: now }),
		});
	}
}
