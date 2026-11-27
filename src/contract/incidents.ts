import { z } from "zod";
import "./common";

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
export const INCIDENT_STATUSES = ["open", "acknowledged", "resolved"] as const;
export const INCIDENT_ORIGINS = ["manual", "alert"] as const;

export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const IncidentIdSchema = z.uuid().brand<"IncidentId">();
export type IncidentId = z.infer<typeof IncidentIdSchema>;

export const CreateIncidentRequestSchema = z
	.strictObject({
		title: z.string().trim().min(3).max(200),
		severity: z.enum(INCIDENT_SEVERITIES),
	})
	.openapi("CreateIncidentRequest");

export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequestSchema>;

export const AssignIncidentRequestSchema = z
	.strictObject({
		// A member of the caller's tenant, or null to unassign (admins only).
		assigneeId: z.uuid().nullable(),
	})
	.openapi("AssignIncidentRequest");

export type AssignIncidentRequest = z.infer<typeof AssignIncidentRequestSchema>;

// Strict so a leaked internal field, such as tenantId, fails the contract test.
export const IncidentSchema = z
	.strictObject({
		id: z.uuid(),
		title: z.string(),
		severity: z.enum(INCIDENT_SEVERITIES),
		status: z.enum(INCIDENT_STATUSES),
		createdAt: z.iso.datetime(),
		acknowledgedAt: z.iso.datetime().nullable(),
		resolvedAt: z.iso.datetime().nullable(),
		// "alert" when an alert source opened it. See docs/features/alert-ingestion.md.
		origin: z.enum(INCIDENT_ORIGINS),
		alertCount: z.number().int(),
		lastAlertAt: z.iso.datetime().nullable(),
		// Who owns it. See docs/features/on-call-schedules.md.
		assignee: z.strictObject({ id: z.uuid(), email: z.string() }).nullable(),
		// Written or accepted by a member. See docs/features/ai-summaries.md.
		summary: z
			.strictObject({
				text: z.string(),
				updatedAt: z.iso.datetime(),
				updatedBy: z.string(),
				// The AI draft it was accepted from, or null when written by hand.
				draftId: z.uuid().nullable(),
			})
			.nullable(),
	})
	.openapi("Incident");

export type IncidentResponse = z.infer<typeof IncidentSchema>;

export const IncidentListSchema = z
	.strictObject({
		items: z.array(IncidentSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("IncidentList");

export type IncidentListResponse = z.infer<typeof IncidentListSchema>;
