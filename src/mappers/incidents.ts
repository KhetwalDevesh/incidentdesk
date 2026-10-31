import type { IncidentResponse } from "../contract/incidents";
import type { Incident } from "../domain/incidents/types";

// The allowlist of what leaves the API. A new domain field stays private until added here.
export const toIncidentResponse = (incident: Incident): IncidentResponse => ({
	id: incident.id,
	title: incident.title,
	severity: incident.severity,
	status: incident.status,
	createdAt: incident.createdAt.toISOString(),
});
