import { z } from "zod";
import { SUMMARY_DRAFT_STATES, SUMMARY_FAILURE_REASONS } from "./summaries";

// Spec: docs/features/ai-postmortems.md

export const POSTMORTEM_STATES = ["draft", "published"] as const;
export const MAX_POSTMORTEM_BODY = 20_000;

const listOf = (max: number) => z.array(z.string().trim().min(1).max(300)).max(max);

// What the model must return. Sent to it as a JSON schema, and checked again here, limits
// included, before anything is stored.
export const PostmortemContentSchema = z
	.strictObject({
		summary: z.string().trim().min(1).max(1000),
		impact: z.string().trim().min(1).max(1000),
		timeline: z
			.array(
				z.strictObject({
					at: z.iso.datetime({ offset: true }),
					event: z.string().trim().min(1).max(200),
				}),
			)
			.min(1)
			.max(30),
		suspectedCause: z.string().trim().min(1).max(1500),
		wentWell: listOf(10),
		wentWrong: listOf(10),
		actionItems: listOf(10),
	})
	.openapi("PostmortemContent", {
		description: "The sections of an AI postmortem draft. A suggestion, reviewed by a person.",
	});

export type PostmortemContent = z.infer<typeof PostmortemContentSchema>;

// Strict so internal fields, such as token counts or the last error, fail the contract test.
export const PostmortemDraftSchema = z
	.strictObject({
		id: z.uuid(),
		incidentId: z.uuid(),
		state: z.enum(SUMMARY_DRAFT_STATES),
		// Only for a ready draft.
		content: PostmortemContentSchema.nullable(),
		// The model that wrote a ready draft: an AI suggestion, labelled as such.
		model: z.string().nullable(),
		failureReason: z.enum(SUMMARY_FAILURE_REASONS).nullable(),
		requestedBy: z.string().nullable(),
		createdAt: z.iso.datetime(),
		completedAt: z.iso.datetime().nullable(),
	})
	.openapi("PostmortemDraft");

export type PostmortemDraftResponse = z.infer<typeof PostmortemDraftSchema>;

export const PostmortemDraftListSchema = z
	.strictObject({
		items: z.array(PostmortemDraftSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("PostmortemDraftList");

export const SavePostmortemRequestSchema = z
	.strictObject({
		// Markdown. Without it, the body is the draft rendered as Markdown.
		body: z.string().trim().min(1).max(MAX_POSTMORTEM_BODY).optional(),
		// A ready draft of this incident, recorded as the source.
		draftId: z.uuid().optional(),
	})
	.refine((input) => input.body !== undefined || input.draftId !== undefined, {
		message: "Give a body, a draftId, or both",
		path: ["body"],
	})
	.openapi("SavePostmortemRequest");

export type SavePostmortemRequest = z.infer<typeof SavePostmortemRequestSchema>;

export const PostmortemSchema = z
	.strictObject({
		incidentId: z.uuid(),
		body: z.string(),
		state: z.enum(POSTMORTEM_STATES),
		draftId: z.uuid().nullable(),
		updatedAt: z.iso.datetime(),
		updatedBy: z.string(),
		publishedAt: z.iso.datetime().nullable(),
		publishedBy: z.string().nullable(),
	})
	.openapi("Postmortem");

export type PostmortemResponse = z.infer<typeof PostmortemSchema>;
