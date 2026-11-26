import type { Pool } from "pg";
import type { IncidentSeverity } from "../../contract/incidents";
import type {
	IncidentStatsReader,
	LoadPage,
	StatsWindow,
	UnresolvedStats,
} from "../../domain/dashboard/types";
import type { TenantId } from "../../domain/shared/identity";
import { emptyStats } from "./emptyStats";

// Spec: docs/features/dashboard-stats.md

// Unresolved incidents of the tenant, opened in the window when there is one. $1 is the
// tenant, $2 and $3 the window's bounds or nulls. Served by incidents_tenant_unresolved_idx.
const UNRESOLVED = `tenant_id = $1 AND status <> 'resolved'
	AND ($2::timestamptz IS NULL OR (created_at >= $2 AND created_at < $3))`;

const bounds = (window: StatsWindow) => [window?.from ?? null, window?.to ?? null];

export class PostgresIncidentStatsReader implements IncidentStatsReader {
	constructor(private readonly pool: Pool) {}

	async unresolvedStats(tenantId: TenantId, window: StatsWindow): Promise<UnresolvedStats> {
		const { rows } = await this.pool.query<{
			severity: IncidentSeverity;
			status: "open" | "acknowledged";
			count: number;
			unassigned: number;
		}>(
			`SELECT severity, status, count(*)::int AS count,
				count(*) FILTER (WHERE assignee_id IS NULL)::int AS unassigned
			FROM incidents WHERE ${UNRESOLVED}
			GROUP BY severity, status`,
			[tenantId, ...bounds(window)],
		);
		const stats = emptyStats();
		for (const row of rows) {
			stats.bySeverity[row.severity][row.status] = row.count;
			stats.unassigned += row.unassigned;
		}
		return stats;
	}

	async load(tenantId: TenantId, window: StatsWindow, limit: number): Promise<LoadPage> {
		// The window function counts every group before LIMIT cuts the list.
		const { rows } = await this.pool.query<{
			assignee_id: string;
			open: number;
			acknowledged: number;
			assignee_count: number;
		}>(
			`SELECT assignee_id,
				count(*) FILTER (WHERE status = 'open')::int AS open,
				count(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
				(count(*) OVER ())::int AS assignee_count
			FROM incidents WHERE ${UNRESOLVED} AND assignee_id IS NOT NULL
			GROUP BY assignee_id
			ORDER BY count(*) DESC, assignee_id
			LIMIT $4`,
			[tenantId, ...bounds(window), limit],
		);
		return {
			items: rows.map((row) => ({
				userId: row.assignee_id,
				open: row.open,
				acknowledged: row.acknowledged,
			})),
			assigneeCount: rows[0]?.assignee_count ?? 0,
		};
	}
}
