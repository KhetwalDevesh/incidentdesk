import { z } from "zod";
import { INCIDENT_SEVERITIES } from "./incidents";

export const NOTIFICATION_CHANNEL_KINDS = ["slack_webhook"] as const;

export const CreateNotificationChannelRequestSchema = z
	.strictObject({
		name: z.string().trim().min(1).max(100),
		// The origin must also be on the server's allowlist, which the service checks (422).
		// See docs/features/slack-delivery.md.
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

export const NotificationChannelIdSchema = z.uuid();

// Spec: docs/features/slack-delivery.md
export const NOTIFICATION_EVENTS = [
	"incident.opened",
	"incident.acknowledged",
	"incident.resolved",
	// Spec: docs/features/on-call-schedules.md.
	"incident.reassigned",
] as const;
export const DELIVERY_STATES = ["pending", "delivered", "failed"] as const;
export const DELIVERY_FAILURE_REASONS = ["rejected", "unavailable", "host_not_allowed"] as const;

// Strict so the payload, the actor's email or Slack's response text cannot leak by accident.
export const NotificationDeliverySchema = z
	.strictObject({
		id: z.uuid(),
		event: z.enum(NOTIFICATION_EVENTS),
		incidentId: z.uuid(),
		state: z.enum(DELIVERY_STATES),
		attempts: z.number().int(),
		failureReason: z.enum(DELIVERY_FAILURE_REASONS).nullable(),
		lastStatus: z.number().int().nullable(),
		createdAt: z.iso.datetime(),
		deliveredAt: z.iso.datetime().nullable(),
	})
	.openapi("NotificationDelivery", {
		description:
			"One message to one channel. failureReason is rejected (a 4xx other than 429, or a redirect), unavailable (5xx, 429, timeout or network error until the last attempt) or host_not_allowed. lastStatus is the last HTTP status Slack answered with, or null if none.",
	});

export type NotificationDeliveryResponse = z.infer<typeof NotificationDeliverySchema>;

export const NotificationDeliveryListSchema = z
	.strictObject({
		items: z.array(NotificationDeliverySchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("NotificationDeliveryList");
