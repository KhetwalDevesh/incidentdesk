import { z } from "zod";
import "./common";

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
export const INCIDENT_STATUSES = ["open", "acknowledged", "resolved"] as const;

export const IncidentIdSchema = z.uuid().brand<"IncidentId">();
export type IncidentId = z.infer<typeof IncidentIdSchema>;

export const CreateIncidentRequestSchema = z
	.strictObject({
		title: z.string().trim().min(3).max(200),
		severity: z.enum(INCIDENT_SEVERITIES),
	})
	.openapi("CreateIncidentRequest");

export type CreateIncidentRequest = z.infer<typeof CreateIncidentRequestSchema>;

// Strict so a leaked internal field, such as tenantId, fails the contract test.
export const IncidentSchema = z
	.strictObject({
		id: z.uuid(),
		title: z.string(),
		severity: z.enum(INCIDENT_SEVERITIES),
		status: z.enum(INCIDENT_STATUSES),
		createdAt: z.iso.datetime(),
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
