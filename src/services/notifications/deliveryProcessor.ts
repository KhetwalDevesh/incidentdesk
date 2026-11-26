import {
	channelSecretContext,
	type DeliveryOutbox,
	type DeliveryProcessor,
	type DeliveryRef,
	type NotificationChannelRepository,
	type NotificationDelivery,
	type NotificationDeliveryRepository,
	type NotificationQueue,
	type SecretBox,
	type WebhookPolicy,
	type WebhookResult,
	type WebhookSender,
} from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";
import type { QueueMessage } from "../../domain/shared/queue";
import { slackMessage } from "./slackMessage";

// Spec: docs/features/slack-delivery.md, "Response handling".

// Delay before retry n+1, after counted attempt n fails. Attempt 5 failing fails the delivery.
export const DELIVERY_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;
export const DELIVERY_MAX_ATTEMPTS = DELIVERY_RETRY_DELAYS_MS.length + 1;
// A delivery still undelivered this long after it was created fails, so a channel that is
// always rate limited cannot retry forever.
export const DELIVERY_DEADLINE_MS = 60 * 60_000;
// Slack's Retry-After is honoured up to this.
export const DELIVERY_MAX_RETRY_AFTER_MS = 10 * 60_000;

// As for alerts: the sweeper re-sends a pending delivery once it is this overdue.
export const DELIVERY_UNSENT_RESEND_MS = 2 * 60_000;
export const DELIVERY_SENT_RESEND_MS = 15 * 60_000;

export type DeliveryProcessorDeps = {
	queue: NotificationQueue;
	deliveries: NotificationDeliveryRepository;
	outbox: DeliveryOutbox;
	channels: NotificationChannelRepository;
	secrets: SecretBox;
	sender: WebhookSender;
	policy: WebhookPolicy;
	now?: () => Date;
	batchSize?: number;
	waitSeconds?: number;
	// Must equal the queue's visibility timeout. See AlertProcessorDeps.
	visibilityTimeoutMs?: number;
	sweepBatchSize?: number;
	// Gets a delivery or message id, never a payload or URL.
	onError?: (subject: string, error: unknown) => void;
};

const MAX_ID_LENGTH = 200;
const isId = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

// The body is untrusted until this returns a ref.
const parseRef = (body: string): DeliveryRef | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { tenantId, deliveryId } = parsed as Record<string, unknown>;
	return isId(tenantId) && isId(deliveryId) ? { tenantId: tenantId as TenantId, deliveryId } : null;
};

// Retry-After is either delay seconds or an HTTP date. Null when missing or unparseable.
export const parseRetryAfter = (value: string | null, now: Date): number | null => {
	if (value === null) return null;
	const trimmed = value.trim();
	if (/^\d{1,10}$/.test(trimmed)) return Number(trimmed) * 1000;
	// Only the HTTP date form (RFC 9110 IMF-fixdate). Date.parse alone reads "-5" as a year.
	if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed))
		return null;
	const at = Date.parse(trimmed);
	return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
};

// What one answer means for the delivery.
type Verdict =
	| { kind: "delivered"; status: number }
	| {
			kind: "retry";
			counted: boolean;
			delayMs: number | null;
			status: number | null;
			error: string;
	  }
	| { kind: "rejected"; status: number; error: string };

export const judge = (result: WebhookResult, now: Date): Verdict => {
	if (result.kind === "error") {
		return { kind: "retry", counted: true, delayMs: null, status: null, error: result.error };
	}
	const { status } = result;
	if (status >= 200 && status < 300) return { kind: "delivered", status };
	if (status === 429) {
		const retryAfter = parseRetryAfter(result.retryAfter, now);
		return {
			kind: "retry",
			counted: false,
			delayMs: retryAfter === null ? null : Math.min(retryAfter, DELIVERY_MAX_RETRY_AFTER_MS),
			status,
			error: "rate limited",
		};
	}
	if (status >= 500 || status === 408) {
		return { kind: "retry", counted: true, delayMs: null, status, error: `HTTP ${status}` };
	}
	// 3xx (a refused redirect) and every other 4xx: a retry cannot succeed.
	return {
		kind: "rejected",
		status,
		error: status < 400 ? `redirect ${status}` : `HTTP ${status}`,
	};
};

export const createDeliveryProcessor = ({
	queue,
	deliveries,
	outbox,
	channels,
	secrets,
	sender,
	policy,
	now = () => new Date(),
	batchSize = 10,
	waitSeconds = 20,
	visibilityTimeoutMs = 60_000,
	sweepBatchSize = 100,
	onError = () => undefined,
}: DeliveryProcessorDeps): DeliveryProcessor => {
	// Every failure goes through here, so no path forgets the email removal or the message.
	const failFor = async (
		delivery: NotificationDelivery,
		message: QueueMessage,
		outcome: Parameters<NotificationDeliveryRepository["fail"]>[2],
	) => {
		await deliveries.fail(delivery.tenantId, delivery.id, outcome);
		await queue.delete(message);
	};

	const send = async (delivery: NotificationDelivery, message: QueueMessage) => {
		const channel = await channels.findById(delivery.tenantId, delivery.channelId);
		if (!channel) {
			await failFor(delivery, message, {
				reason: "rejected",
				status: null,
				error: "channel not found",
			});
			return;
		}
		const url = secrets.open(
			channel.targetCiphertext,
			channelSecretContext(channel.tenantId, channel.id),
		);
		// Checked again at send time: the channel may predate the allowlist, or the list shrank.
		if (!policy.allows(url)) {
			await failFor(delivery, message, {
				reason: "host_not_allowed",
				status: null,
				error: "webhook origin is not on the allowlist",
			});
			return;
		}

		const result = await sender.post(
			url,
			slackMessage(delivery.event, delivery.incidentId, delivery.payload),
		);
		const at = now();
		const verdict = judge(result, at);

		if (verdict.kind === "delivered") {
			await deliveries.deliver(delivery.tenantId, delivery.id, verdict.status, at);
			await queue.delete(message);
			return;
		}
		if (verdict.kind === "rejected") {
			await failFor(delivery, message, {
				reason: "rejected",
				status: verdict.status,
				error: verdict.error,
			});
			return;
		}

		const counted = verdict.counted ? delivery.attempts : delivery.attempts - 1;
		const backoff = DELIVERY_RETRY_DELAYS_MS[Math.max(counted, 1) - 1];
		const delayMs = verdict.delayMs ?? backoff;
		const deadline = delivery.createdAt.getTime() + DELIVERY_DEADLINE_MS;
		const outOfAttempts = verdict.counted && delivery.attempts >= DELIVERY_MAX_ATTEMPTS;
		if (delayMs === undefined || outOfAttempts || at.getTime() + delayMs > deadline) {
			await failFor(delivery, message, {
				reason: "unavailable",
				status: verdict.status,
				error: verdict.error,
			});
			return;
		}
		await deliveries.retry(delivery.tenantId, delivery.id, {
			retryAt: new Date(at.getTime() + delayMs),
			counted: verdict.counted,
			status: verdict.status,
			error: verdict.error,
		});
		await queue.retryAfter(message, delayMs);
	};

	const handle = async (message: QueueMessage) => {
		const ref = parseRef(message.body);
		if (!ref) {
			onError(`message ${message.id}`, new Error("malformed delivery message"));
			await queue.delete(message);
			return;
		}

		const startedAt = now();
		const start = await deliveries.startAttempt(
			ref.tenantId,
			ref.deliveryId,
			startedAt,
			new Date(startedAt.getTime() + visibilityTimeoutMs),
		);
		// Unknown, delivered or failed: a duplicate or stale message.
		if (start === null) {
			await queue.delete(message);
			return;
		}
		// Another attempt holds it: a duplicate message arriving mid-send, or a message back a
		// moment before its retry is due. Look again when the hold ends.
		if (start.status === "leased") {
			await queue.retryAfter(message, Math.max(1000, start.until.getTime() - startedAt.getTime()));
			return;
		}

		const { delivery } = start;
		// Earlier attempts started but never recorded an outcome: the worker crashed each time.
		if (delivery.attempts > DELIVERY_MAX_ATTEMPTS) {
			await failFor(delivery, message, {
				reason: "unavailable",
				status: delivery.lastStatus,
				error: `Gave up after ${DELIVERY_MAX_ATTEMPTS} attempts that did not finish`,
			});
			return;
		}
		if (startedAt.getTime() > delivery.createdAt.getTime() + DELIVERY_DEADLINE_MS) {
			await failFor(delivery, message, {
				reason: "unavailable",
				status: delivery.lastStatus,
				error: "not delivered within 1 hour",
			});
			return;
		}

		try {
			await send(delivery, message);
		} catch (error) {
			// A database or decryption error. The lease expires with the message's visibility,
			// so it comes back, and this attempt counts.
			onError(`delivery ${delivery.id}`, error);
		}
	};

	return {
		async processMessages() {
			const messages = await queue.receive(batchSize, waitSeconds);
			for (const message of messages) {
				try {
					await handle(message);
				} catch (error) {
					onError(`message ${message.id}`, error);
				}
			}
			return messages.length;
		},

		async sweep() {
			const at = now();
			const claimed = await outbox.claimOverdue(
				{
					unsentBefore: new Date(at.getTime() - DELIVERY_UNSENT_RESEND_MS),
					sentBefore: new Date(at.getTime() - DELIVERY_SENT_RESEND_MS),
				},
				at,
				sweepBatchSize,
			);
			for (const ref of claimed) {
				try {
					await queue.send(ref);
					await deliveries.markSent(ref.tenantId, ref.deliveryId, now());
				} catch (error) {
					onError(`delivery ${ref.deliveryId}`, error);
				}
			}
			return claimed.length;
		},
	};
};
