import type { NotificationChannelResponse } from "../contract/notificationChannels";
import type { NotificationChannel } from "../domain/notifications/types";

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
