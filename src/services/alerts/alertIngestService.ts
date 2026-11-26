import { randomUUID } from "node:crypto";
import { ALERT_SIGNATURE_TOLERANCE_SECONDS, AlertSourceIdSchema } from "../../contract/alerts";
import {
	type AlertIngestService,
	type AlertQueue,
	type AlertRepository,
	type AlertSignatureVerifier,
	type AlertSourceLookup,
	alertSourceSecretContext,
	type VerifiedAlertSource,
} from "../../domain/alerts/types";
import type { SecretBox } from "../../domain/notifications/types";
import { fail, ok } from "../../domain/shared/result";

const UNIX_SECONDS = /^\d{1,12}$/;

export type AlertIngestServiceDeps = {
	sources: AlertSourceLookup;
	alerts: AlertRepository;
	queue: AlertQueue;
	secrets: SecretBox;
	signatures: AlertSignatureVerifier;
	now?: () => Date;
	// Gets the alert id, never its payload. A failed send is not an error for the caller:
	// the row is saved, and the sweeper sends it later.
	onSendError?: (alertId: string, error: unknown) => void;
};

export const createAlertIngestService = ({
	sources,
	alerts,
	queue,
	secrets,
	signatures,
	now = () => new Date(),
	onSendError = () => undefined,
}: AlertIngestServiceDeps): AlertIngestService => {
	// One answer for an unknown source, a stale timestamp and a bad signature,
	// so probing cannot tell which source ids exist.
	const refused = () => fail("UNAUTHENTICATED", "The alert signature is missing or invalid");

	return {
		async verify({ sourceId, timestamp, signature, rawBody }) {
			if (!timestamp || !signature || !UNIX_SECONDS.test(timestamp)) return refused();
			if (!AlertSourceIdSchema.safeParse(sourceId).success) return refused();

			const skewSeconds = Math.abs(now().getTime() / 1000 - Number(timestamp));
			if (skewSeconds > ALERT_SIGNATURE_TOLERANCE_SECONDS) return refused();

			const source = await sources.findForIngest(sourceId);
			if (!source) return refused();

			const secret = secrets.open(
				source.secretCiphertext,
				alertSourceSecretContext(source.tenantId, source.id),
			);
			if (!signatures.verify(secret, timestamp, rawBody, signature)) return refused();
			return ok(source as VerifiedAlertSource);
		},

		async enqueue(source, payload) {
			const receivedAt = now();
			// The tenant comes from the verified source row, never from the request.
			const alert = await alerts.enqueue(source.tenantId, {
				id: randomUUID(),
				sourceId: source.id,
				dedupKey: payload.dedupKey,
				status: payload.status,
				title: payload.title,
				severity: payload.severity,
				details: payload.details ?? {},
				state: "pending",
				attempts: 0,
				nextAttemptAt: receivedAt,
				lastError: null,
				incidentId: null,
				receivedAt,
				processedAt: null,
				sentAt: null,
			});
			// The row is written first, so it stays the source of truth even when this send fails.
			try {
				await queue.send({ tenantId: alert.tenantId, alertId: alert.id });
				const sentAt = now();
				await alerts.markSent(alert.tenantId, alert.id, sentAt);
				return ok({ ...alert, sentAt });
			} catch (error) {
				onSendError(alert.id, error);
				return ok(alert);
			}
		},
	};
};
