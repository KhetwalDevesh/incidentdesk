import { randomUUID } from "node:crypto";
import type { IncidentId } from "../../contract/incidents";
import type {
	Alert,
	AlertOutbox,
	AlertProcessor,
	AlertQueue,
	AlertQueueMessage,
	AlertRef,
	AlertRepository,
} from "../../domain/alerts/types";
import type { Incident } from "../../domain/incidents/types";

// Delay before retry n+1, after attempt n fails. Attempt 5 failing marks the alert failed.
export const ALERT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;
export const ALERT_MAX_ATTEMPTS = ALERT_RETRY_DELAYS_MS.length + 1;

// The sweeper re-sends a pending alert once its nextAttemptAt is this overdue. An alert never
// sent waits briefly. A sent one waits longer than any backoff (10 minutes) or plausible queue
// backlog, so the sweeper never duplicates a message that is merely slow.
export const ALERT_UNSENT_RESEND_MS = 2 * 60_000;
export const ALERT_SENT_RESEND_MS = 15 * 60_000;

export type AlertProcessorDeps = {
	queue: AlertQueue;
	alerts: AlertRepository;
	outbox: AlertOutbox;
	now?: () => Date;
	newId?: () => string;
	batchSize?: number;
	// How long a long poll waits for messages.
	waitSeconds?: number;
	// Must equal the queue's visibility timeout: while a message is hidden, its alert counts as
	// in flight, and the sweeper leaves it alone.
	visibilityTimeoutMs?: number;
	sweepBatchSize?: number;
	// Gets an alert or message id, never a payload, so logs cannot carry alert content.
	onError?: (subject: string, error: unknown) => void;
};

const MAX_ID_LENGTH = 200;
const isId = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

// The body is untrusted until this returns a ref.
const parseRef = (body: string): AlertRef | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { tenantId, alertId } = parsed as Record<string, unknown>;
	return isId(tenantId) && isId(alertId)
		? { tenantId: tenantId as AlertRef["tenantId"], alertId }
		: null;
};

const errorText = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 1000);

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
	outbox,
	now = () => new Date(),
	newId = randomUUID,
	batchSize = 10,
	waitSeconds = 20,
	visibilityTimeoutMs = 60_000,
	sweepBatchSize = 100,
	onError = () => undefined,
}: AlertProcessorDeps): AlertProcessor => {
	const handle = async (message: AlertQueueMessage) => {
		const ref = parseRef(message.body);
		if (!ref) {
			onError(`message ${message.id}`, new Error("malformed alert message"));
			await queue.delete(message);
			return;
		}

		const startedAt = now();
		const alert = await alerts.startAttempt(
			ref.tenantId,
			ref.alertId,
			new Date(startedAt.getTime() + visibilityTimeoutMs),
		);
		// Unknown, or already processed or failed: a duplicate or stale message.
		if (!alert) {
			await queue.delete(message);
			return;
		}

		// Earlier attempts started but never recorded an outcome: the worker crashed each time.
		if (alert.attempts > ALERT_MAX_ATTEMPTS) {
			await alerts.fail(
				alert.tenantId,
				alert.id,
				`Gave up after ${ALERT_MAX_ATTEMPTS} attempts that did not finish`,
				null,
				now(),
			);
			await queue.delete(message);
			return;
		}

		try {
			const at = now();
			await alerts.complete(alert.tenantId, alert.id, candidateFor(alert, newId(), at), at);
		} catch (error) {
			onError(`alert ${alert.id}`, error);
			const at = now();
			const delay = ALERT_RETRY_DELAYS_MS[alert.attempts - 1];
			const retryAt = delay === undefined ? null : new Date(at.getTime() + delay);
			await alerts.fail(alert.tenantId, alert.id, errorText(error), retryAt, at);
			if (delay !== undefined) {
				await queue.retryAfter(message, delay);
				return;
			}
		}
		// Deleted only after the outcome is committed. A crash before this redelivers the message.
		await queue.delete(message);
	};

	return {
		async processMessages() {
			const messages = await queue.receive(batchSize, waitSeconds);
			for (const message of messages) {
				try {
					await handle(message);
				} catch (error) {
					// Left undeleted: it comes back after the visibility timeout, and its attempt counts.
					onError(`message ${message.id}`, error);
				}
			}
			return messages.length;
		},

		async sweep() {
			const at = now();
			const claimed = await outbox.claimOverdue(
				{
					unsentBefore: new Date(at.getTime() - ALERT_UNSENT_RESEND_MS),
					sentBefore: new Date(at.getTime() - ALERT_SENT_RESEND_MS),
				},
				at,
				sweepBatchSize,
			);
			for (const ref of claimed) {
				try {
					await queue.send(ref);
					await alerts.markSent(ref.tenantId, ref.alertId, now());
				} catch (error) {
					// Claimed at `at`, so the next sweep after the cutoff tries again.
					onError(`alert ${ref.alertId}`, error);
				}
			}
			return claimed.length;
		},
	};
};
