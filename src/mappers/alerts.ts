import type {
	AlertAcceptedResponse,
	AlertResponse,
	AlertSourceResponse,
	CreatedAlertSourceResponse,
} from "../contract/alerts";
import type { Alert, AlertSource, CreatedAlertSource } from "../domain/alerts/types";

// The allowlists of what leaves the API. Ciphertext, tenantId and lastError never do.

export const toAlertSourceResponse = (source: AlertSource): AlertSourceResponse => ({
	id: source.id,
	name: source.name,
	secretHint: `…${source.secretHint}`,
	createdAt: source.createdAt.toISOString(),
});

// The only response that carries the plaintext secret.
export const toCreatedAlertSourceResponse = ({
	source,
	secret,
}: CreatedAlertSource): CreatedAlertSourceResponse => ({
	...toAlertSourceResponse(source),
	secret,
});

export const toAlertAcceptedResponse = (alert: Alert): AlertAcceptedResponse => ({
	alertId: alert.id,
});

export const toAlertResponse = (alert: Alert): AlertResponse => ({
	id: alert.id,
	sourceId: alert.sourceId,
	dedupKey: alert.dedupKey,
	status: alert.status,
	title: alert.title,
	severity: alert.severity,
	details: alert.details,
	state: alert.state,
	attempts: alert.attempts,
	incidentId: alert.incidentId,
	receivedAt: alert.receivedAt.toISOString(),
	processedAt: alert.processedAt?.toISOString() ?? null,
});
