import type { SummaryDraftResponse } from "../contract/summaries";
import type { SummaryDraft } from "../domain/summaries/types";

// The allowlist of what leaves the API. Token counts, the last error and tenantId never do.
export const toSummaryDraftResponse = (draft: SummaryDraft): SummaryDraftResponse => ({
	id: draft.id,
	incidentId: draft.incidentId,
	state: draft.state,
	summary: draft.summary,
	suggestedSeverity: draft.suggestedSeverity,
	rationale: draft.rationale,
	model: draft.model,
	failureReason: draft.failureReason,
	requestedBy: draft.requestedBy,
	createdAt: draft.createdAt.toISOString(),
	completedAt: draft.completedAt?.toISOString() ?? null,
});
