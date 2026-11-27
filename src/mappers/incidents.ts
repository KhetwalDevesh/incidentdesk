import type { IncidentResponse } from "../contract/incidents";
import type { IncidentView } from "../domain/incidents/types";

// The allowlist of what leaves the API. A new domain field stays private until added here.
export const toIncidentResponse = (incident: IncidentView): IncidentResponse => ({
	id: incident.id,
	title: incident.title,
	severity: incident.severity,
	status: incident.status,
	createdAt: incident.createdAt.toISOString(),
	acknowledgedAt: incident.acknowledgedAt?.toISOString() ?? null,
	resolvedAt: incident.resolvedAt?.toISOString() ?? null,
	origin: incident.alertSourceId ? "alert" : "manual",
	alertCount: incident.alertCount,
	lastAlertAt: incident.lastAlertAt?.toISOString() ?? null,
	assignee: incident.assignee ? { id: incident.assignee.id, email: incident.assignee.email } : null,
	summary: incident.summary
		? {
				text: incident.summary.text,
				updatedAt: incident.summary.updatedAt.toISOString(),
				updatedBy: incident.summary.updatedBy,
				draftId: incident.summary.draftId,
			}
		: null,
});
