import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type { Incident, IncidentRepository } from "../../domain/incidents/types";
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
}
