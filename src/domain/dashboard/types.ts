import type { IncidentSeverity } from "../../contract/incidents";
import type { Principal, TenantId } from "../shared/identity";
import type { Result } from "../shared/result";

// Spec: docs/features/dashboard-stats.md

// Incidents opened at or after `from` and before `to`. Null: every incident.
export type StatsWindow = { from: Date; to: Date } | null;

export type StatusCounts = { open: number; acknowledged: number };

// Unresolved incidents only.
export type UnresolvedStats = {
	bySeverity: Record<IncidentSeverity, StatusCounts>;
	unassigned: number;
};

export type AssigneeLoad = StatusCounts & { userId: string };

// Most loaded first, then by user id. assigneeCount counts every assignee, past the limit.
export type LoadPage = { items: AssigneeLoad[]; assigneeCount: number };

// Tenant-scoped. Every method takes tenantId first, like every repository.
export interface IncidentStatsReader {
	unresolvedStats(tenantId: TenantId, window: StatsWindow): Promise<UnresolvedStats>;
	load(tenantId: TenantId, window: StatsWindow, limit: number): Promise<LoadPage>;
}

export type Dashboard = {
	generatedAt: Date;
	window: StatsWindow;
	totals: StatusCounts & { unassigned: number };
	bySeverity: Record<IncidentSeverity, StatusCounts>;
	// Most loaded first, then by email.
	load: (AssigneeLoad & { email: string })[];
	assigneeCount: number;
};

export interface DashboardService {
	get(principal: Principal, window: StatsWindow): Promise<Result<Dashboard>>;
}
