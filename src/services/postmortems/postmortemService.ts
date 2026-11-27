import { randomUUID } from "node:crypto";
import { auditEntry, auditOrigin } from "../../domain/audit/types";
import type { IncidentRepository } from "../../domain/incidents/types";
import type {
	PostmortemDraftRepository,
	PostmortemRepository,
	PostmortemService,
} from "../../domain/postmortems/types";
import { fail, ok, type Result } from "../../domain/shared/result";
import { renderPostmortem } from "./postmortemMarkdown";

// Spec: docs/features/ai-postmortems.md

export type PostmortemServiceDeps = {
	incidents: Pick<IncidentRepository, "findById">;
	drafts: PostmortemDraftRepository;
	postmortems: PostmortemRepository;
	dailyCap: number;
	now?: () => Date;
};

const INCIDENT_NOT_FOUND = "Incident not found";
const NOT_RESOLVED = "Postmortems are for resolved incidents";

const draftNotFound: Result<never> = {
	ok: false,
	error: {
		code: "NOT_FOUND",
		detail: "Postmortem draft not found",
		errors: [{ path: "draftId", message: "Not a ready draft of this incident" }],
	},
};

// Every member may request, save and publish (the user's decision). The AI only drafts: a
// draft reaches the postmortem only when a member saves it.
export const createPostmortemService = ({
	incidents,
	drafts,
	postmortems,
	dailyCap,
	now = () => new Date(),
}: PostmortemServiceDeps): PostmortemService => ({
	async requestDraft(principal, incidentId) {
		const incident = await incidents.findById(principal.tenantId, incidentId);
		if (!incident) return fail("NOT_FOUND", INCIDENT_NOT_FOUND);
		if (incident.status !== "resolved") return fail("CONFLICT", NOT_RESOLVED);
		return ok(
			await drafts.request(principal.tenantId, {
				id: randomUUID(),
				incidentId,
				requestedBy: principal.userId,
				createdAt: now(),
				dailyCap,
			}),
		);
	},

	async listDrafts(principal, incidentId, page) {
		const incident = await incidents.findById(principal.tenantId, incidentId);
		if (!incident) return fail("NOT_FOUND", INCIDENT_NOT_FOUND);
		return ok(await drafts.list(principal.tenantId, incidentId, page));
	},

	async get(principal, incidentId) {
		const incident = await incidents.findById(principal.tenantId, incidentId);
		if (!incident) return fail("NOT_FOUND", INCIDENT_NOT_FOUND);
		const postmortem = await postmortems.find(principal.tenantId, incidentId);
		return postmortem ? ok(postmortem) : fail("NOT_FOUND", "No postmortem yet");
	},

	async save(principal, incidentId, { body, draftId }, context) {
		const incident = await incidents.findById(principal.tenantId, incidentId);
		if (!incident) return fail("NOT_FOUND", INCIDENT_NOT_FOUND);
		if (incident.status !== "resolved") return fail("CONFLICT", NOT_RESOLVED);
		let text = body;
		if (draftId !== undefined) {
			const draft = await drafts.findById(principal.tenantId, draftId);
			if (draft?.incidentId !== incidentId || draft.state !== "ready" || !draft.content) {
				return draftNotFound;
			}
			text ??= renderPostmortem(draft.content);
		}
		// The schema requires a body or a draftId, and a draftId always yields a body above.
		if (text === undefined) return fail("VALIDATION_FAILED", "Give a body, a draftId, or both");

		const at = now();
		return ok(
			await postmortems.save(
				principal.tenantId,
				incidentId,
				{ body: text, draftId: draftId ?? null, updatedBy: principal.userId, updatedAt: at },
				auditEntry(
					auditOrigin(at, context),
					principal.tenantId,
					"postmortem.saved",
					{ type: "user", id: principal.userId },
					{ type: "incident", id: incidentId },
					{ source: draftId ? "draft" : "manual", draftId: draftId ?? "none" },
				),
			),
		);
	},

	async publish(principal, incidentId, context) {
		const incident = await incidents.findById(principal.tenantId, incidentId);
		if (!incident) return fail("NOT_FOUND", INCIDENT_NOT_FOUND);
		const at = now();
		const published = await postmortems.publish(
			principal.tenantId,
			incidentId,
			principal.userId,
			at,
			auditEntry(
				auditOrigin(at, context),
				principal.tenantId,
				"postmortem.published",
				{ type: "user", id: principal.userId },
				{ type: "incident", id: incidentId },
				{},
			),
		);
		return published ? ok(published) : fail("NOT_FOUND", "No postmortem yet");
	},
});
