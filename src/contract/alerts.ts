import { z } from "zod";
import { PageQuerySchema } from "./common";
import { INCIDENT_SEVERITIES } from "./incidents";

// Spec: docs/features/alert-ingestion.md

export const ALERT_STATUSES = ["firing", "resolved"] as const;
export const ALERT_STATES = ["pending", "processed", "failed"] as const;

export const ALERT_SIGNATURE_HEADER = "X-IncidentDesk-Signature";
export const ALERT_TIMESTAMP_HEADER = "X-IncidentDesk-Timestamp";
// A signed request older or newer than this is refused.
export const ALERT_SIGNATURE_TOLERANCE_SECONDS = 300;
export const ALERT_MAX_BODY_BYTES = 64 * 1024;

export const AlertSourceIdSchema = z.uuid();

export const CreateAlertSourceRequestSchema = z
	.strictObject({
		name: z.string().trim().min(1).max(100),
		// The schedule that assigns its incidents. See docs/features/on-call-schedules.md.
		onCallScheduleId: z.uuid().nullable().default(null),
	})
	.openapi("CreateAlertSourceRequest");

export type CreateAlertSourceRequest = z.infer<typeof CreateAlertSourceRequestSchema>;

export const UpdateAlertSourceRequestSchema = z
	.strictObject({
		// Null unlinks it: its incidents are then assigned from the default schedule.
		onCallScheduleId: z.uuid().nullable(),
	})
	.openapi("UpdateAlertSourceRequest");

export type UpdateAlertSourceRequest = z.infer<typeof UpdateAlertSourceRequestSchema>;

// Strict so the secret or its ciphertext cannot leak by accident.
export const AlertSourceSchema = z
	.strictObject({
		id: z.uuid(),
		name: z.string(),
		secretHint: z.string(),
		onCallScheduleId: z.uuid().nullable(),
		createdAt: z.iso.datetime(),
	})
	.openapi("AlertSource", {
		description: "The signing secret is never returned. secretHint shows its last 4 characters.",
	});

export type AlertSourceResponse = z.infer<typeof AlertSourceSchema>;

export const CreatedAlertSourceSchema = AlertSourceSchema.extend({
	secret: z.string(),
}).openapi("CreatedAlertSource", {
	description: "Returned once, on create. Store the secret now: it is never shown again.",
});

export type CreatedAlertSourceResponse = z.infer<typeof CreatedAlertSourceSchema>;

export const AlertSourceListSchema = z
	.strictObject({
		items: z.array(AlertSourceSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("AlertSourceList");

const DETAIL_VALUE = z.union([z.string().max(1000), z.number(), z.boolean()]);

export const AlertPayloadSchema = z
	.strictObject({
		dedupKey: z.string().min(1).max(200),
		title: z.string().trim().min(3).max(200),
		severity: z.enum(INCIDENT_SEVERITIES),
		status: z.enum(ALERT_STATUSES).default("firing"),
		details: z
			.record(z.string().max(100), DETAIL_VALUE)
			.refine((details) => Object.keys(details).length <= 50, "At most 50 keys")
			.optional(),
	})
	.openapi("AlertPayload");

export type AlertPayload = z.infer<typeof AlertPayloadSchema>;
export type AlertDetails = NonNullable<AlertPayload["details"]>;

export const AlertWebhookHeadersSchema = z.object({
	[ALERT_TIMESTAMP_HEADER]: z.string().openapi({ description: "Unix time in seconds" }),
	[ALERT_SIGNATURE_HEADER]: z.string().openapi({
		description: "v1= followed by the hex HMAC-SHA256 of `{timestamp}.{raw body}`",
	}),
});

export const AlertAcceptedSchema = z
	.strictObject({
		alertId: z.uuid(),
	})
	.openapi("AlertAccepted");

export type AlertAcceptedResponse = z.infer<typeof AlertAcceptedSchema>;

export const AlertListQuerySchema = PageQuerySchema.extend({
	state: z.enum(ALERT_STATES).optional(),
});

export type AlertListQuery = z.infer<typeof AlertListQuerySchema>;

// Strict so internal fields, such as lastError or tenantId, fail the contract test.
export const AlertSchema = z
	.strictObject({
		id: z.uuid(),
		sourceId: z.uuid(),
		dedupKey: z.string(),
		status: z.enum(ALERT_STATUSES),
		title: z.string(),
		severity: z.enum(INCIDENT_SEVERITIES),
		details: z.record(z.string(), DETAIL_VALUE),
		state: z.enum(ALERT_STATES),
		attempts: z.number().int(),
		incidentId: z.uuid().nullable(),
		receivedAt: z.iso.datetime(),
		processedAt: z.iso.datetime().nullable(),
	})
	.openapi("Alert");

export type AlertResponse = z.infer<typeof AlertSchema>;

export const AlertListSchema = z
	.strictObject({
		items: z.array(AlertSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
		state: z.enum(ALERT_STATES).optional(),
	})
	.openapi("AlertList");
