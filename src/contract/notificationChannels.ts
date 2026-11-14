import { z } from "zod";
import { INCIDENT_SEVERITIES } from "./incidents";

export const NOTIFICATION_CHANNEL_KINDS = ["slack_webhook"] as const;

export const CreateNotificationChannelRequestSchema = z
	.strictObject({
		name: z.string().trim().min(1).max(100),
		// Any URL is accepted, by the user's decision. See docs/features/slack-notifications.md.
		webhookUrl: z.url().max(2048),
		minSeverity: z.enum(INCIDENT_SEVERITIES).default("sev4"),
		enabled: z.boolean().default(true),
	})
	.openapi("CreateNotificationChannelRequest");

export type CreateNotificationChannelRequest = z.infer<
	typeof CreateNotificationChannelRequestSchema
>;

// Strict so the webhook URL or its ciphertext cannot leak by accident.
export const NotificationChannelSchema = z
	.strictObject({
		id: z.uuid(),
		kind: z.enum(NOTIFICATION_CHANNEL_KINDS),
		name: z.string(),
		webhookUrlHint: z.string(),
		minSeverity: z.enum(INCIDENT_SEVERITIES),
		enabled: z.boolean(),
		createdAt: z.iso.datetime(),
	})
	.openapi("NotificationChannel", {
		description: "The webhook URL is never returned. webhookUrlHint shows its last 4 characters.",
	});

export type NotificationChannelResponse = z.infer<typeof NotificationChannelSchema>;

export const NotificationChannelListSchema = z
	.strictObject({
		items: z.array(NotificationChannelSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("NotificationChannelList");
