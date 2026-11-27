import type { IncidentId } from "../../contract/incidents";
import type { AuditEntry } from "../../domain/audit/types";
import type { Postmortem, PostmortemRepository } from "../../domain/postmortems/types";
import type { TenantId } from "../../domain/shared/identity";
import type { InMemoryAuditStore } from "../audit/inMemoryAuditStore";
import type { InMemoryChangeFeed } from "../events/inMemoryChangeFeed";

// The twin of the Postgres repository. No await between a check and its write.
export class InMemoryPostmortemRepository implements PostmortemRepository {
	private readonly postmortems = new Map<string, Postmortem>();

	constructor(
		private readonly audit: InMemoryAuditStore,
		private readonly feed: InMemoryChangeFeed,
	) {}

	private key(tenantId: TenantId, incidentId: IncidentId) {
		return `${tenantId}:${incidentId}`;
	}

	async find(tenantId: TenantId, incidentId: IncidentId): Promise<Postmortem | null> {
		return this.postmortems.get(this.key(tenantId, incidentId)) ?? null;
	}

	async save(
		tenantId: TenantId,
		incidentId: IncidentId,
		change: { body: string; draftId: string | null; updatedBy: string; updatedAt: Date },
		audit: AuditEntry,
	): Promise<Postmortem> {
		this.audit.checkSync([audit]);
		const current = this.postmortems.get(this.key(tenantId, incidentId));
		const saved: Postmortem = {
			tenantId,
			incidentId,
			state: current?.state ?? "draft",
			publishedAt: current?.publishedAt ?? null,
			publishedBy: current?.publishedBy ?? null,
			...change,
		};
		this.postmortems.set(this.key(tenantId, incidentId), saved);
		this.audit.appendSync([audit]);
		this.feed.publishSync({ kind: "postmortem", tenantId, incidentId });
		return saved;
	}

	async publish(
		tenantId: TenantId,
		incidentId: IncidentId,
		by: string,
		at: Date,
		audit: AuditEntry,
	): Promise<Postmortem | null> {
		const current = this.postmortems.get(this.key(tenantId, incidentId));
		if (!current || current.state === "published") return current ?? null;
		this.audit.checkSync([audit]);
		const published: Postmortem = {
			...current,
			state: "published",
			publishedBy: by,
			publishedAt: at,
		};
		this.postmortems.set(this.key(tenantId, incidentId), published);
		this.audit.appendSync([audit]);
		this.feed.publishSync({ kind: "postmortem", tenantId, incidentId });
		return published;
	}
}
