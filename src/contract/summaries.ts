import { z } from "zod";
import { INCIDENT_SEVERITIES } from "./incidents";

// Spec: docs/features/ai-summaries.md

export const SUMMARY_DRAFT_STATES = ["pending", "ready", "failed", "skipped"] as const;
export const SUMMARY_FAILURE_REASONS = [
	"provider_error",
	"invalid_output",
	"over_daily_cap",
	"ai_disabled",
] as const;

export const SummaryDraftIdSchema = z.uuid();

// What the model must return. Sent to it as a strict JSON schema, and checked again here,
// with these limits, before anything is stored.
export const DraftOutputSchema = z.strictObject({
	summary: z.string().trim().min(1).max(600),
	suggestedSeverity: z.enum(INCIDENT_SEVERITIES),
	rationale: z.string().trim().min(1).max(300),
});

export type DraftOutput = z.infer<typeof DraftOutputSchema>;

// Strict so internal fields, such as token counts or the last error, fail the contract test.
export const SummaryDraftSchema = z
	.strictObject({
		id: z.uuid(),
		incidentId: z.uuid(),
		state: z.enum(SUMMARY_DRAFT_STATES),
		summary: z.string().nullable(),
		suggestedSeverity: z.enum(INCIDENT_SEVERITIES).nullable(),
		rationale: z.string().nullable(),
		// The model that wrote a ready draft: an AI suggestion, labelled as such.
		model: z.string().nullable(),
		failureReason: z.enum(SUMMARY_FAILURE_REASONS).nullable(),
		// A member id, or null for a draft made when the incident opened.
		requestedBy: z.string().nullable(),
		createdAt: z.iso.datetime(),
		completedAt: z.iso.datetime().nullable(),
	})
	.openapi("SummaryDraft", {
		description: "An AI suggestion. It changes nothing until a member accepts it.",
	});

export type SummaryDraftResponse = z.infer<typeof SummaryDraftSchema>;

export const SummaryDraftListSchema = z
	.strictObject({
		items: z.array(SummaryDraftSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("SummaryDraftList");

export const SetSummaryRequestSchema = z
	.strictObject({
		text: z.string().trim().min(1).max(2000),
		// Sets the incident's severity too. Refused on a resolved incident.
		severity: z.enum(INCIDENT_SEVERITIES).optional(),
		// The ready draft this summary was accepted from, if any.
		draftId: SummaryDraftIdSchema.optional(),
	})
	.openapi("SetSummaryRequest");

export type SetSummaryRequest = z.infer<typeof SetSummaryRequestSchema>;
