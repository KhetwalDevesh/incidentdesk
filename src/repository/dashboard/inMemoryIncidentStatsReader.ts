import type {
	AssigneeLoad,
	IncidentStatsReader,
	LoadPage,
	StatsWindow,
	UnresolvedStats,
} from "../../domain/dashboard/types";
import type { Incident } from "../../domain/incidents/types";
import type { TenantId } from "../../domain/shared/identity";
import type { InMemoryIncidentRepository } from "../incidents/inMemoryIncidentRepository";
import { emptyStats } from "./emptyStats";

// The twin of the Postgres reader, counting over the shared incident store.
export class InMemoryIncidentStatsReader implements IncidentStatsReader {
	constructor(private readonly incidents: InMemoryIncidentRepository) {}

	private unresolved(tenantId: TenantId, window: StatsWindow) {
		return this.incidents
			.allSync(tenantId)
			.filter(
				(incident): incident is Incident & { status: "open" | "acknowledged" } =>
					incident.status !== "resolved" &&
					(window === null ||
						(incident.createdAt >= window.from && incident.createdAt < window.to)),
			);
	}

	async unresolvedStats(tenantId: TenantId, window: StatsWindow): Promise<UnresolvedStats> {
		const stats = emptyStats();
		for (const incident of this.unresolved(tenantId, window)) {
			stats.bySeverity[incident.severity][incident.status] += 1;
			if (incident.assigneeId === null) stats.unassigned += 1;
		}
		return stats;
	}

	async load(tenantId: TenantId, window: StatsWindow, limit: number): Promise<LoadPage> {
		const byAssignee = new Map<string, AssigneeLoad>();
		for (const incident of this.unresolved(tenantId, window)) {
			if (incident.assigneeId === null) continue;
			const row = byAssignee.get(incident.assigneeId) ?? {
				userId: incident.assigneeId,
				open: 0,
				acknowledged: 0,
			};
			row[incident.status] += 1;
			byAssignee.set(incident.assigneeId, row);
		}
		// Same order as Postgres: most loaded first, then by id. Lowercase UUID text sorts like
		// its bytes.
		const sorted = [...byAssignee.values()].sort(
			(a, b) =>
				b.open + b.acknowledged - (a.open + a.acknowledged) ||
				(a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
		);
		return { items: sorted.slice(0, limit), assigneeCount: sorted.length };
	}
}
