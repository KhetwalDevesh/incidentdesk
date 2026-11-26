import type { PageQuery } from "../../contract/common";
import type {
	AlertSource,
	AlertSourceLookup,
	AlertSourcePage,
	AlertSourceRepository,
	AlertSourceWriteOutcome,
} from "../../domain/alerts/types";
import type { AuditEntry } from "../../domain/audit/types";
import type { TenantId } from "../../domain/shared/identity";
import { InMemoryAuditStore } from "../audit/inMemoryAuditStore";
import type { InMemoryOnCallRepository } from "../onCall/inMemoryOnCallRepository";

const byCreatedThenId = (a: AlertSource, b: AlertSource) =>
	a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Methods do not await between a check and its write, so each one is atomic like its SQL twin.
export class InMemoryAlertSourceRepository implements AlertSourceRepository, AlertSourceLookup {
	private readonly sources: AlertSource[] = [];

	constructor(
		readonly audit: InMemoryAuditStore = new InMemoryAuditStore(),
		// Without it, the tenant has no schedules to link to.
		private readonly schedules: InMemoryOnCallRepository | null = null,
	) {
		// The twin of ON DELETE SET NULL (on_call_schedule_id).
		schedules?.deleteHooks.push((tenantId, scheduleId) => {
			for (const [index, source] of this.sources.entries()) {
				if (source.tenantId === tenantId && source.onCallScheduleId === scheduleId) {
					this.sources[index] = { ...source, onCallScheduleId: null };
				}
			}
		});
	}

	// The twin of the composite foreign key to on_call_schedules.
	private scheduleExists(tenantId: TenantId, scheduleId: string | null) {
		return scheduleId === null || (this.schedules?.hasScheduleSync(tenantId, scheduleId) ?? false);
	}

	async create(
		tenantId: TenantId,
		source: Omit<AlertSource, "tenantId">,
		audit: AuditEntry,
	): Promise<AlertSourceWriteOutcome> {
		const exists = this.scheduleExists(tenantId, source.onCallScheduleId);
		const nameTaken = this.sources.some(
			(existing) => existing.tenantId === tenantId && existing.name === source.name,
		);
		if (nameTaken) return { status: "name_taken" };
		if (!exists) return { status: "schedule_not_found" };
		this.audit.checkSync([audit]);
		const created = { ...source, tenantId };
		this.sources.push(created);
		this.audit.appendSync([audit]);
		return { status: "saved", source: created };
	}

	async link(
		tenantId: TenantId,
		id: string,
		onCallScheduleId: string | null,
		audit: AuditEntry,
	): Promise<AlertSourceWriteOutcome> {
		const exists = this.scheduleExists(tenantId, onCallScheduleId);
		const index = this.sources.findIndex(
			(source) => source.tenantId === tenantId && source.id === id,
		);
		const source = this.sources[index];
		if (!source) return { status: "not_found" };
		if (!exists) return { status: "schedule_not_found" };
		this.audit.checkSync([audit]);
		const linked = { ...source, onCallScheduleId };
		this.sources[index] = linked;
		this.audit.appendSync([audit]);
		return { status: "saved", source: linked };
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
