import type {
	NotificationChannelResponse,
	NotificationDeliveryResponse,
} from "../contract/notificationChannels";
import type { NotificationChannel, NotificationDelivery } from "../domain/notifications/types";

// The allowlist of what leaves the API. The ciphertext and tenantId never do.
export const toNotificationChannelResponse = (
	channel: NotificationChannel,
): NotificationChannelResponse => ({
	id: channel.id,
	kind: channel.kind,
	name: channel.name,
	webhookUrlHint: `…${channel.targetHint}`,
	minSeverity: channel.minSeverity,
	enabled: channel.enabled,
	createdAt: channel.createdAt.toISOString(),
});

// The allowlist for a delivery. The payload (with the actor's email), the channel, the
// tenant and the internal error text never leave the API.
export const toNotificationDeliveryResponse = (
	delivery: NotificationDelivery,
): NotificationDeliveryResponse => ({
	id: delivery.id,
	event: delivery.event,
	incidentId: delivery.incidentId,
	state: delivery.state,
	attempts: delivery.attempts,
	failureReason: delivery.failureReason,
	lastStatus: delivery.lastStatus,
	createdAt: delivery.createdAt.toISOString(),
	deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
});
