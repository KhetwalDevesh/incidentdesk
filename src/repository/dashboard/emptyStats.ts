import { INCIDENT_SEVERITIES } from "../../contract/incidents";
import type { UnresolvedStats } from "../../domain/dashboard/types";

// Every severity present with zeros, for both readers to count into.
export const emptyStats = (): UnresolvedStats => ({
	bySeverity: Object.fromEntries(
		INCIDENT_SEVERITIES.map((severity) => [severity, { open: 0, acknowledged: 0 }]),
	) as UnresolvedStats["bySeverity"],
	unassigned: 0,
});
