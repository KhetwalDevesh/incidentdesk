import { randomUUID } from "node:crypto";
import type { IncidentId } from "../../contract/incidents";
import { type AuditEntry, auditEntry, auditOrigin } from "../../domain/audit/types";
import type { Incident, IncidentRepository, IncidentView } from "../../domain/incidents/types";
import type { TenantId } from "../../domain/shared/identity";
import { fail, ok, type Result } from "../../domain/shared/result";
import type { SummaryDraftRepository, SummaryService } from "../../domain/summaries/types";

// Spec: docs/features/ai-summaries.md

export type SummaryServiceDeps = {
	incidents: Pick<IncidentRepository, "findById" | "setSummary">;
	drafts: SummaryDraftRepository;
	// Shows incidents exactly as the incident routes do, with the assignee's email.
	views: (tenantId: TenantId, incidents: Incident[]) => Promise<IncidentView[]>;
	dailyCap: number;
	now?: () => Date;
};

const INCIDENT_NOT_FOUND = "Incident not found";

const draftNotFound: Result<never> = {
	ok: false,
	error: {
		code: "NOT_FOUND",
		detail: "Summary draft not found",
		errors: [{ path: "draftId", message: "Not a ready draft of this incident" }],
	},
};

export const createSummaryService = ({
	incidents,
	drafts,
	views,
	dailyCap,
	now = () => new Date(),
}: SummaryServiceDeps): SummaryService => ({
	// Every member may ask: the cap, not the role, limits cost.
	async requestDraft(principal, incidentId) {
		const incident = await incidents.findById(principal.tenantId, incidentId);
		if (!incident) return fail("NOT_FOUND", INCIDENT_NOT_FOUND);
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

	// Any member may set the summary and the severity (the user's decision). The AI only
	// suggests: this is the one place a draft reaches the incident, and a person chose it.
	async setSummary(principal, incidentId, { text, severity, draftId }, context) {
		const incident = await incidents.findById(principal.tenantId, incidentId);
		if (!incident) return fail("NOT_FOUND", INCIDENT_NOT_FOUND);
		const severityChange =
			severity !== undefined && severity !== incident.severity
				? { from: incident.severity, to: severity }
				: null;
		if (severityChange && incident.status === "resolved") {
			return fail("CONFLICT", "A resolved incident's severity cannot change");
		}
		if (draftId !== undefined) {
			const draft = await drafts.findById(principal.tenantId, draftId);
			if (draft?.incidentId !== incidentId || draft.state !== "ready") return draftNotFound;
		}

		const at = now();
		const origin = () => auditOrigin(at, context);
		const actor = { type: "user", id: principal.userId } as const;
		const resource = { type: "incident", id: incidentId } as const;
		const entries: AuditEntry[] = [
			auditEntry(origin(), principal.tenantId, "incident.summary_set", actor, resource, {
				source: draftId ? "draft" : "manual",
				draftId: draftId ?? "none",
			}),
			...(severityChange
				? [
						auditEntry(origin(), principal.tenantId, "incident.severity_changed", actor, resource, {
							from: severityChange.from,
							to: severityChange.to,
						}),
					]
				: []),
		];
		const updated = await incidents.setSummary(
			principal.tenantId,
			incidentId as IncidentId,
			{
				summary: { text, updatedAt: at, updatedBy: principal.userId, draftId: draftId ?? null },
				severity: severityChange,
			},
			entries,
		);
		// Resolved, or its severity changed, since the read above.
		if (!updated) return fail("CONFLICT", "Incident changed while setting its summary");
		const [view] = await views(principal.tenantId, [updated]);
		return view ? ok(view) : fail("NOT_FOUND", INCIDENT_NOT_FOUND);
	},
});
