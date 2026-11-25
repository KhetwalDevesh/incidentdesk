import { randomUUID } from "node:crypto";
import type { IncidentId } from "../../contract/incidents";
import type { Alert, AlertProcessor, AlertQueue, AlertRepository } from "../../domain/alerts/types";
import type { Incident } from "../../domain/incidents/types";

// Delay before retry n+1, after attempt n fails. Attempt 5 failing marks the alert failed.
export const ALERT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;
export const ALERT_MAX_ATTEMPTS = ALERT_RETRY_DELAYS_MS.length + 1;

export type AlertProcessorDeps = {
	queue: AlertQueue;
	alerts: AlertRepository;
	now?: () => Date;
	newId?: () => string;
	batchSize?: number;
	// Longer than any single alert takes, so a live worker never loses its claim.
	leaseMs?: number;
	// Gets the alert id, never its payload, so logs cannot carry alert content.
	onError?: (alertId: string, error: unknown) => void;
};

// A firing alert may open an incident. A resolved one only attaches to an existing one:
// people resolve incidents, alerts do not.
const candidateFor = (alert: Alert, id: string, at: Date): Omit<Incident, "tenantId"> | null =>
	alert.status === "firing"
		? {
				id: id as IncidentId,
				title: alert.title,
				severity: alert.severity,
				status: "open",
				createdAt: at,
				createdBy: `alert_source:${alert.sourceId}`,
				acknowledgedAt: null,
				acknowledgedBy: null,
				resolvedAt: null,
				resolvedBy: null,
				alertSourceId: alert.sourceId,
				dedupKey: alert.dedupKey,
				alertCount: 1,
				lastAlertAt: alert.receivedAt,
			}
		: null;

export const createAlertProcessor = ({
	queue,
	alerts,
	now = () => new Date(),
	newId = randomUUID,
	batchSize = 10,
	leaseMs = 60_000,
	onError = () => undefined,
}: AlertProcessorDeps): AlertProcessor => ({
	async processBatch() {
		const claimedAt = now();
		const claimed = await queue.claimDue(
			claimedAt,
			batchSize,
			new Date(claimedAt.getTime() + leaseMs),
		);
		for (const alert of claimed) {
			try {
				const at = now();
				await alerts.complete(alert.tenantId, alert.id, candidateFor(alert, newId(), at), at);
			} catch (error) {
				onError(alert.id, error);
				const at = now();
				const delay = ALERT_RETRY_DELAYS_MS[alert.attempts - 1];
				const retryAt = delay === undefined ? null : new Date(at.getTime() + delay);
				const message = error instanceof Error ? error.message : String(error);
				await alerts.fail(alert.tenantId, alert.id, message.slice(0, 1000), retryAt, at);
			}
		}
		return claimed.length;
	},
});
