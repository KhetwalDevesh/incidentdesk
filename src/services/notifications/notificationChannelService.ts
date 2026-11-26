import { randomUUID } from "node:crypto";
import { auditEntry, auditOrigin } from "../../domain/audit/types";
import {
	channelSecretContext,
	type NotificationChannelRepository,
	type NotificationChannelService,
	type NotificationDeliveryRepository,
	type SecretBox,
	type WebhookPolicy,
} from "../../domain/notifications/types";
import { isAdmin } from "../../domain/shared/identity";
import { fail, ok } from "../../domain/shared/result";

const HINT_LENGTH = 4;

export type NotificationChannelServiceDeps = {
	channels: NotificationChannelRepository;
	deliveries: NotificationDeliveryRepository;
	secrets: SecretBox;
	// The same allowlist the worker checks before every send.
	policy: WebhookPolicy;
	now?: () => Date;
};

export const createNotificationChannelService = ({
	channels,
	deliveries,
	secrets,
	policy,
	now = () => new Date(),
}: NotificationChannelServiceDeps): NotificationChannelService => ({
	async list(principal, page) {
		if (!isAdmin(principal)) {
			return fail("FORBIDDEN", "Only admins can list notification channels");
		}
		return ok(await channels.list(principal.tenantId, page));
	},

	async create(principal, { name, webhookUrl, minSeverity, enabled }, context) {
		if (!isAdmin(principal)) {
			return fail("FORBIDDEN", "Only admins can add notification channels");
		}
		// Spec: docs/features/slack-delivery.md. The message names the rule, never the allowlist.
		if (!policy.allows(webhookUrl)) {
			return {
				ok: false,
				error: {
					code: "VALIDATION_FAILED",
					detail: "The request is invalid",
					errors: [{ path: "webhookUrl", message: "The webhook URL's host is not allowed" }],
				},
			};
		}
		const id = randomUUID();
		const createdAt = now();
		const created = await channels.create(
			principal.tenantId,
			{
				id,
				kind: "slack_webhook",
				name,
				targetCiphertext: secrets.seal(webhookUrl, channelSecretContext(principal.tenantId, id)),
				targetHint: webhookUrl.slice(-HINT_LENGTH),
				minSeverity,
				enabled,
				createdAt,
			},
			// The name and kind only: never the webhook URL or its hint.
			auditEntry(
				auditOrigin(createdAt, context),
				principal.tenantId,
				"notification_channel.created",
				{ type: "user", id: principal.userId },
				{ type: "notification_channel", id },
				{ name, type: "slack_webhook" },
			),
		);
		if (!created) return fail("CONFLICT", "A notification channel with this name already exists");
		return ok(created);
	},

	async listDeliveries(principal, channelId, page) {
		if (!isAdmin(principal)) return fail("FORBIDDEN", "Only admins can list deliveries");
		// Another tenant's channel is not found, so its existence is not revealed.
		const channel = await channels.findById(principal.tenantId, channelId);
		if (!channel) return fail("NOT_FOUND", "Notification channel not found");
		return ok(await deliveries.listForChannel(principal.tenantId, channelId, page));
	},
});
