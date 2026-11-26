import type { DashboardResponse } from "../contract/dashboard";
import type { Dashboard } from "../domain/dashboard/types";

// The allowlist of what leaves the API.
export const toDashboardResponse = (dashboard: Dashboard): DashboardResponse => ({
	generatedAt: dashboard.generatedAt.toISOString(),
	window: dashboard.window
		? { from: dashboard.window.from.toISOString(), to: dashboard.window.to.toISOString() }
		: null,
	totals: {
		open: dashboard.totals.open,
		acknowledged: dashboard.totals.acknowledged,
		unassigned: dashboard.totals.unassigned,
	},
	bySeverity: {
		sev1: { ...dashboard.bySeverity.sev1 },
		sev2: { ...dashboard.bySeverity.sev2 },
		sev3: { ...dashboard.bySeverity.sev3 },
		sev4: { ...dashboard.bySeverity.sev4 },
	},
	load: dashboard.load.map((row) => ({
		userId: row.userId,
		email: row.email,
		open: row.open,
		acknowledged: row.acknowledged,
		total: row.open + row.acknowledged,
	})),
	assigneeCount: dashboard.assigneeCount,
});
