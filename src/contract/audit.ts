import { z } from "zod";
import { PageQuerySchema } from "./common";

// Spec: docs/features/audit-log.md. A new value here also needs a migration that widens the
// audit_events CHECK constraint, and may reach clients only once they can read it.
export const AUDIT_ACTIONS = [
	"tenant.created",
	"member.invited",
	"member.setup_completed",
	"member.role_changed",
	"member.removed",
	"user.login_succeeded",
	"user.login_failed",
	"user.login_locked",
	"incident.created",
	"incident.acknowledged",
	"incident.resolved",
	"incident.assigned",
	"incident.summary_set",
	"incident.severity_changed",
	"alert.grouped",
	"alert_source.created",
	"alert_source.updated",
	"notification_channel.created",
	"on_call_schedule.created",
	"on_call_schedule.updated",
	"on_call_schedule.deleted",
	"on_call_override.created",
	"on_call_override.deleted",
] as const;

export const AUDIT_RESOURCE_TYPES = [
	"tenant",
	"user",
	"incident",
	"alert_source",
	"notification_channel",
	"on_call_schedule",
] as const;

export const AUDIT_ACTOR_TYPES = ["user", "alert_source", "anonymous"] as const;

const AuditIdSchema = z.string().min(1).max(100);

export const AuditEventQuerySchema = PageQuerySchema.extend({
	action: z.enum(AUDIT_ACTIONS).optional(),
	resourceType: z.enum(AUDIT_RESOURCE_TYPES).optional(),
	resourceId: AuditIdSchema.optional(),
	actorId: AuditIdSchema.optional(),
	// Inclusive bounds on occurredAt.
	from: z.iso.datetime({ offset: true }).optional(),
	to: z.iso.datetime({ offset: true }).optional(),
}).refine(({ from, to }) => !from || !to || Date.parse(from) <= Date.parse(to), {
	path: ["from"],
	message: "from must not be later than to",
});

export type AuditEventQuery = z.infer<typeof AuditEventQuerySchema>;

// Strict so a leaked internal field, such as tenantId, fails the contract test.
export const AuditEventSchema = z
	.strictObject({
		id: z.uuid(),
		occurredAt: z.iso.datetime(),
		action: z.enum(AUDIT_ACTIONS),
		actor: z.strictObject({
			type: z.enum(AUDIT_ACTOR_TYPES),
			// Null only for an anonymous actor, such as a failed sign-in.
			id: z.string().nullable(),
		}),
		resource: z.strictObject({ type: z.enum(AUDIT_RESOURCE_TYPES), id: z.string() }),
		// A small allowlist per action. Never secrets or personal data beyond ids.
		details: z.record(z.string(), z.string()),
		// The request that caused the change. Null for changes the worker made.
		requestId: z.string().nullable(),
	})
	.openapi("AuditEvent");

export type AuditEventResponse = z.infer<typeof AuditEventSchema>;

export const AuditEventListSchema = z
	.strictObject({
		items: z.array(AuditEventSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("AuditEventList");

export type AuditEventListResponse = z.infer<typeof AuditEventListSchema>;
