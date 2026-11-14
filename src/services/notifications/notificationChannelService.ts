import { randomUUID } from "node:crypto";
import {
	channelSecretContext,
	type NotificationChannelRepository,
	type NotificationChannelService,
	type SecretBox,
} from "../../domain/notifications/types";
import { isAdmin } from "../../domain/shared/identity";
import { fail, ok } from "../../domain/shared/result";

const HINT_LENGTH = 4;

export const createNotificationChannelService = (
	channels: NotificationChannelRepository,
	secrets: SecretBox,
	now: () => Date = () => new Date(),
): NotificationChannelService => ({
	async list(principal, page) {
		if (!isAdmin(principal)) {
			return fail("FORBIDDEN", "Only admins can list notification channels");
		}
		return ok(await channels.list(principal.tenantId, page));
	},

	async create(principal, { name, webhookUrl, minSeverity, enabled }) {
		if (!isAdmin(principal)) {
			return fail("FORBIDDEN", "Only admins can add notification channels");
		}
		const id = randomUUID();
		const created = await channels.create(principal.tenantId, {
			id,
			kind: "slack_webhook",
			name,
			targetCiphertext: secrets.seal(webhookUrl, channelSecretContext(principal.tenantId, id)),
			targetHint: webhookUrl.slice(-HINT_LENGTH),
			minSeverity,
			enabled,
			createdAt: now(),
		});
		if (!created) return fail("CONFLICT", "A notification channel with this name already exists");
		return ok(created);
	},
});
