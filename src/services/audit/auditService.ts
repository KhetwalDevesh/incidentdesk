import type { AuditEventReader, AuditService } from "../../domain/audit/types";
import type { IncidentRepository } from "../../domain/incidents/types";
import { fail, ok } from "../../domain/shared/result";

// Spec: docs/features/audit-log.md. Every role may read the whole tenant log (user decision),
// so there is no role check here: requireAuth already proved the caller is a member.
export const createAuditService = (
	events: AuditEventReader,
	incidents: IncidentRepository,
): AuditService => ({
	async list(principal, { limit, offset, from, to, ...filter }) {
		return ok(
			await events.list(
				principal.tenantId,
				{
					...filter,
					from: from ? new Date(from) : undefined,
					to: to ? new Date(to) : undefined,
				},
				{ limit, offset },
			),
		);
	},

	async incidentTimeline(principal, incidentId, page) {
		// Another tenant's incident is "not found", so its existence is not revealed.
		const incident = await incidents.findById(principal.tenantId, incidentId);
		if (!incident) return fail("NOT_FOUND", "Incident not found");
		return ok(
			await events.listForResource(principal.tenantId, { type: "incident", id: incident.id }, page),
		);
	},
});
