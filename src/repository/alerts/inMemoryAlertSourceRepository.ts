import type { PageQuery } from "../../contract/common";
import type {
	AlertSource,
	AlertSourceLookup,
	AlertSourcePage,
	AlertSourceRepository,
} from "../../domain/alerts/types";
import type { AuditEntry } from "../../domain/audit/types";
import type { TenantId } from "../../domain/shared/identity";
import { InMemoryAuditStore } from "../audit/inMemoryAuditStore";

const byCreatedThenId = (a: AlertSource, b: AlertSource) =>
	a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Methods do not await between a check and its write, so each one is atomic like its SQL twin.
export class InMemoryAlertSourceRepository implements AlertSourceRepository, AlertSourceLookup {
	private readonly sources: AlertSource[] = [];

	constructor(readonly audit: InMemoryAuditStore = new InMemoryAuditStore()) {}

	async create(
		tenantId: TenantId,
		source: Omit<AlertSource, "tenantId">,
		audit: AuditEntry,
	): Promise<AlertSource | null> {
		const nameTaken = this.sources.some(
			(existing) => existing.tenantId === tenantId && existing.name === source.name,
		);
		if (nameTaken) return null;
		this.audit.checkSync([audit]);
		const created = { ...source, tenantId };
		this.sources.push(created);
		this.audit.appendSync([audit]);
		return created;
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery): Promise<AlertSourcePage> {
		const owned = this.sources
			.filter((source) => source.tenantId === tenantId)
			.sort(byCreatedThenId);
		return { items: owned.slice(offset, offset + limit), total: owned.length };
	}

	async findForIngest(sourceId: string): Promise<AlertSource | null> {
		return this.sources.find((source) => source.id === sourceId) ?? null;
	}
}
