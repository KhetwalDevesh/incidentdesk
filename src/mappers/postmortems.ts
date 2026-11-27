import type { PostmortemDraftResponse, PostmortemResponse } from "../contract/postmortems";
import type { Postmortem, PostmortemDraft } from "../domain/postmortems/types";

// The allowlists of what leaves the API. Token counts, the last error and tenantId never do.

export const toPostmortemDraftResponse = (draft: PostmortemDraft): PostmortemDraftResponse => ({
	id: draft.id,
	incidentId: draft.incidentId,
	state: draft.state,
	content: draft.content,
	model: draft.model,
	failureReason: draft.failureReason,
	requestedBy: draft.requestedBy,
	createdAt: draft.createdAt.toISOString(),
	completedAt: draft.completedAt?.toISOString() ?? null,
});

export const toPostmortemResponse = (postmortem: Postmortem): PostmortemResponse => ({
	incidentId: postmortem.incidentId,
	body: postmortem.body,
	state: postmortem.state,
	draftId: postmortem.draftId,
	updatedAt: postmortem.updatedAt.toISOString(),
	updatedBy: postmortem.updatedBy,
	publishedAt: postmortem.publishedAt?.toISOString() ?? null,
	publishedBy: postmortem.publishedBy,
});
