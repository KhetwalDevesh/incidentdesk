import { MAX_DASHBOARD_LOAD_ROWS } from "../../contract/dashboard";
import type { AccountRepository } from "../../domain/auth/types";
import type {
	Dashboard,
	DashboardService,
	IncidentStatsReader,
	StatsWindow,
	StatusCounts,
} from "../../domain/dashboard/types";
import type { TenantId } from "../../domain/shared/identity";
import { ok } from "../../domain/shared/result";

// Spec: docs/features/dashboard-stats.md

export type DashboardServiceDeps = {
	stats: IncidentStatsReader;
	members: Pick<AccountRepository, "findUsers">;
	now?: () => Date;
};

const sum = (counts: StatusCounts[]) =>
	counts.reduce(
		(total, { open, acknowledged }) => ({
			open: total.open + open,
			acknowledged: total.acknowledged + acknowledged,
		}),
		{ open: 0, acknowledged: 0 },
	);

// Builds the dashboard for a tenant. Shared with the realtime hub, which pushes it after
// incident changes.
export const createDashboardBuilder =
	({ stats, members, now = () => new Date() }: DashboardServiceDeps) =>
	async (tenantId: TenantId, window: StatsWindow): Promise<Dashboard> => {
		const generatedAt = now();
		const [unresolved, load] = await Promise.all([
			stats.unresolvedStats(tenantId, window),
			stats.load(tenantId, window, MAX_DASHBOARD_LOAD_ROWS),
		]);
		const users = await members.findUsers(
			tenantId,
			load.items.map((row) => row.userId),
		);
		const emails = new Map(users.map((user) => [user.id, user.email]));
		return {
			generatedAt,
			window,
			totals: { ...sum(Object.values(unresolved.bySeverity)), unassigned: unresolved.unassigned },
			bySeverity: unresolved.bySeverity,
			// A member removed while this was read has no email: their row is left out, while their
			// incidents still count in the totals.
			load: load.items
				.flatMap((row) => {
					const email = emails.get(row.userId);
					return email === undefined ? [] : [{ ...row, email }];
				})
				.sort(
					(a, b) =>
						b.open + b.acknowledged - (a.open + a.acknowledged) ||
						(a.email < b.email ? -1 : a.email > b.email ? 1 : 0),
				),
			assigneeCount: load.assigneeCount,
		};
	};

export const createDashboardService = (deps: DashboardServiceDeps): DashboardService => {
	const build = createDashboardBuilder(deps);
	return {
		// Every member may read it: the numbers cover incidents and members they can already see.
		get: async (principal, window) => ok(await build(principal.tenantId, window)),
	};
};
