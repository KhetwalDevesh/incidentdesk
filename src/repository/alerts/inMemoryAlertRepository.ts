import type { AlertListQuery } from "../../contract/alerts";
import type { IncidentId } from "../../contract/incidents";
import type { Alert, AlertPage, AlertQueue, AlertRepository } from "../../domain/alerts/types";
import type { Incident } from "../../domain/incidents/types";
import type { TenantId } from "../../domain/shared/identity";
import type { InMemoryIncidentRepository } from "../incidents/inMemoryIncidentRepository";

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Methods do not await between a check and its write, so each one is atomic like its SQL twin.
export class InMemoryAlertRepository implements AlertRepository, AlertQueue {
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

	async claimDue(now: Date, limit: number, leaseUntil: Date): Promise<Alert[]> {
		const due = [...this.alerts.values()]
			.filter((alert) => alert.state === "pending" && alert.nextAttemptAt <= now)
			.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || compareIds(a.id, b.id))
			.slice(0, limit);
		return due.map((alert) => {
			const claimed = { ...alert, attempts: alert.attempts + 1, nextAttemptAt: leaseUntil };
			this.alerts.set(alert.id, claimed);
			return claimed;
		});
	}

	async complete(
		tenantId: TenantId,
		alertId: string,
		candidate: Omit<Incident, "tenantId"> | null,
		processedAt: Date,
	): Promise<{ incidentId: IncidentId | null } | null> {
		const alert = this.alerts.get(alertId);
		if (alert?.tenantId !== tenantId || alert.state !== "pending") return null;

		const existing = this.incidents.findUnresolvedGroupSync(
			tenantId,
			alert.sourceId,
			alert.dedupKey,
		);
		let incidentId: IncidentId | null = null;
		if (existing) {
			this.incidents.putSync({
				...existing,
				alertCount: existing.alertCount + 1,
				lastAlertAt:
					existing.lastAlertAt && existing.lastAlertAt > alert.receivedAt
						? existing.lastAlertAt
						: alert.receivedAt,
			});
			incidentId = existing.id;
		} else if (candidate) {
			this.incidents.putSync({ ...candidate, tenantId });
			incidentId = candidate.id;
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
