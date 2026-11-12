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
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
		return { items: owned.slice(offset, offset + limit), total: owned.length };
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
