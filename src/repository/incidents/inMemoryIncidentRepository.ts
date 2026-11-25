import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type { Incident, IncidentChanges, IncidentRepository } from "../../domain/incidents/types";
import type { TenantId } from "../../domain/shared/identity";

export class InMemoryIncidentRepository implements IncidentRepository {
	private readonly incidents = new Map<IncidentId, Incident>();

	async create(tenantId: TenantId, incident: Omit<Incident, "tenantId">): Promise<Incident> {
		const stored = { ...incident, tenantId };
		this.incidents.set(stored.id, stored);
		return stored;
	}

	async findById(tenantId: TenantId, id: IncidentId): Promise<Incident | null> {
		const incident = this.incidents.get(id);
		return incident?.tenantId === tenantId ? incident : null;
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery) {
		const owned = [...this.incidents.values()]
			.filter((incident) => incident.tenantId === tenantId)
			// Same order as Postgres: newest first, then id. Lowercase UUID text sorts like its bytes.
			.sort(
				(a, b) =>
					b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			);
		return { items: owned.slice(offset, offset + limit), total: owned.length };
	}

	// Used by InMemoryAlertRepository, the twin of the Postgres grouping upsert. Synchronous,
	// so a caller's lookup and write cannot interleave with another caller.
	findUnresolvedGroupSync(tenantId: TenantId, alertSourceId: string, dedupKey: string) {
		for (const incident of this.incidents.values()) {
			if (
				incident.tenantId === tenantId &&
				incident.alertSourceId === alertSourceId &&
				incident.dedupKey === dedupKey &&
				incident.status !== "resolved"
			) {
				return incident;
			}
		}
		return null;
	}

	putSync(incident: Incident) {
		this.incidents.set(incident.id, incident);
	}

	// No await between the check and the write, so the compare-and-set is atomic.
	async update(
		tenantId: TenantId,
		id: IncidentId,
		expectedStatus: Incident["status"],
		changes: IncidentChanges,
	): Promise<Incident | null> {
		const current = this.incidents.get(id);
		if (current?.tenantId !== tenantId || current.status !== expectedStatus) return null;
		const updated = { ...current, ...changes };
		this.incidents.set(id, updated);
		return updated;
	}
}
