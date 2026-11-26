import type { PageQuery } from "../../contract/common";
import type { AuditEntry } from "../../domain/audit/types";
import type {
	OnCallOverride,
	OnCallOverridePage,
	OnCallRepository,
	OnCallSchedule,
	OnCallSchedulePage,
	OverrideAddOutcome,
	ScheduleFields,
	ScheduleWriteOutcome,
} from "../../domain/onCall/types";
import type { TenantId } from "../../domain/shared/identity";
import type { InMemoryAccountRepository } from "../accounts/inMemoryAccountRepository";

type StoredSchedule = Omit<OnCallSchedule, "participants"> & { participantIds: string[] };
type StoredOverride = Omit<OnCallOverride, "email">;

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The twin of the Postgres repository. Methods do not await between a check and its write, so
// each one is atomic like its transaction. Emails are read from the accounts store, as
// Postgres joins users.
export class InMemoryOnCallRepository implements OnCallRepository {
	private readonly schedules = new Map<string, StoredSchedule>();
	private readonly overrides = new Map<string, StoredOverride>();
	// The twins of ON DELETE SET NULL from alert sources to a deleted schedule.
	readonly deleteHooks: ((tenantId: TenantId, scheduleId: string) => void)[] = [];

	constructor(private readonly accounts: InMemoryAccountRepository) {
		// The twins of ON DELETE CASCADE from participants and overrides to users.
		accounts.removalHooks.push((tenantId, userIds) => {
			for (const schedule of this.schedules.values()) {
				if (schedule.tenantId !== tenantId) continue;
				schedule.participantIds = schedule.participantIds.filter((id) => !userIds.has(id));
			}
			for (const [id, override] of this.overrides) {
				if (override.tenantId === tenantId && userIds.has(override.userId)) {
					this.overrides.delete(id);
				}
			}
		});
	}

	private emailOf(tenantId: TenantId, userId: string) {
		return this.accounts.findUserSync(tenantId, userId)?.email ?? "";
	}

	private view(schedule: StoredSchedule): OnCallSchedule {
		const { participantIds, ...rest } = schedule;
		return {
			...rest,
			participants: participantIds.map((userId) => ({
				userId,
				email: this.emailOf(schedule.tenantId, userId),
			})),
		};
	}

	private overrideView(override: StoredOverride): OnCallOverride {
		return { ...override, email: this.emailOf(override.tenantId, override.userId) };
	}

	hasScheduleSync(tenantId: TenantId, id: string): boolean {
		return this.owned(tenantId, id) !== null;
	}

	private owned(tenantId: TenantId, id: string) {
		const schedule = this.schedules.get(id);
		return schedule?.tenantId === tenantId ? schedule : null;
	}

	private nameTaken(tenantId: TenantId, name: string, except: string) {
		return [...this.schedules.values()].some(
			(schedule) =>
				schedule.tenantId === tenantId && schedule.name === name && schedule.id !== except,
		);
	}

	private missingMembers(tenantId: TenantId, ids: string[]) {
		return ids.flatMap((id, index) => (this.accounts.hasMemberSync(tenantId, id) ? [] : [index]));
	}

	private clearDefault(tenantId: TenantId, except: string) {
		for (const schedule of this.schedules.values()) {
			if (schedule.tenantId === tenantId && schedule.id !== except) schedule.isDefault = false;
		}
	}

	async create(
		tenantId: TenantId,
		schedule: ScheduleFields & { createdAt: Date },
		audit: AuditEntry,
	): Promise<ScheduleWriteOutcome> {
		if (this.nameTaken(tenantId, schedule.name, schedule.id)) return { status: "name_taken" };
		const missing = this.missingMembers(tenantId, schedule.participantIds);
		if (missing.length > 0) return { status: "members_not_found", indexes: missing };
		this.accounts.audit.checkSync([audit]);
		if (schedule.isDefault) this.clearDefault(tenantId, schedule.id);
		const stored: StoredSchedule = {
			...schedule,
			participantIds: [...schedule.participantIds],
			tenantId,
		};
		this.schedules.set(stored.id, stored);
		this.accounts.audit.appendSync([audit]);
		return { status: "saved", schedule: this.view(stored) };
	}

	async update(
		tenantId: TenantId,
		id: string,
		patch: Partial<Omit<ScheduleFields, "id">>,
		audit: (before: OnCallSchedule) => AuditEntry,
	): Promise<ScheduleWriteOutcome> {
		const current = this.owned(tenantId, id);
		if (!current) return { status: "not_found" };
		if (patch.name !== undefined && this.nameTaken(tenantId, patch.name, id)) {
			return { status: "name_taken" };
		}
		if (patch.participantIds) {
			const missing = this.missingMembers(tenantId, patch.participantIds);
			if (missing.length > 0) return { status: "members_not_found", indexes: missing };
		}
		const entry = audit(this.view(current));
		this.accounts.audit.checkSync([entry]);
		if (patch.isDefault) this.clearDefault(tenantId, id);
		const defined = Object.fromEntries(
			Object.entries(patch).filter(([, value]) => value !== undefined),
		) as Partial<ScheduleFields>;
		const updated: StoredSchedule = {
			...current,
			...defined,
			participantIds: patch.participantIds ? [...patch.participantIds] : current.participantIds,
		};
		this.schedules.set(id, updated);
		this.accounts.audit.appendSync([entry]);
		return { status: "saved", schedule: this.view(updated) };
	}

	async delete(
		tenantId: TenantId,
		id: string,
		audit: (deleted: OnCallSchedule) => AuditEntry,
	): Promise<boolean> {
		const schedule = this.owned(tenantId, id);
		if (!schedule) return false;
		const entry = audit(this.view(schedule));
		this.accounts.audit.checkSync([entry]);
		this.schedules.delete(id);
		for (const [overrideId, override] of this.overrides) {
			if (override.tenantId === tenantId && override.scheduleId === id) {
				this.overrides.delete(overrideId);
			}
		}
		for (const hook of this.deleteHooks) hook(tenantId, id);
		this.accounts.audit.appendSync([entry]);
		return true;
	}

	async findById(tenantId: TenantId, id: string): Promise<OnCallSchedule | null> {
		const schedule = this.owned(tenantId, id);
		return schedule ? this.view(schedule) : null;
	}

	async findDefault(tenantId: TenantId): Promise<OnCallSchedule | null> {
		const schedule = [...this.schedules.values()].find(
			(candidate) => candidate.tenantId === tenantId && candidate.isDefault,
		);
		return schedule ? this.view(schedule) : null;
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery): Promise<OnCallSchedulePage> {
		// Same order as Postgres: by name in the C collation (code points), then id.
		const owned = [...this.schedules.values()]
			.filter((schedule) => schedule.tenantId === tenantId)
			.sort((a, b) => compareIds(a.name, b.name) || compareIds(a.id, b.id));
		return {
			items: owned.slice(offset, offset + limit).map((schedule) => this.view(schedule)),
			total: owned.length,
		};
	}

	private overridesAfter(tenantId: TenantId, scheduleId: string, at: Date) {
		return [...this.overrides.values()]
			.filter(
				(override) =>
					override.tenantId === tenantId &&
					override.scheduleId === scheduleId &&
					override.endsAt > at,
			)
			.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || compareIds(a.id, b.id));
	}

	async overridesFrom(
		tenantId: TenantId,
		scheduleId: string,
		at: Date,
		limit: number,
	): Promise<OnCallOverride[]> {
		return this.overridesAfter(tenantId, scheduleId, at)
			.slice(0, limit)
			.map((override) => this.overrideView(override));
	}

	async listOverrides(
		tenantId: TenantId,
		scheduleId: string,
		from: Date,
		{ limit, offset }: PageQuery,
	): Promise<OnCallOverridePage> {
		const matching = this.overridesAfter(tenantId, scheduleId, from);
		return {
			items: matching.slice(offset, offset + limit).map((override) => this.overrideView(override)),
			total: matching.length,
		};
	}

	async findOverride(
		tenantId: TenantId,
		scheduleId: string,
		overrideId: string,
	): Promise<OnCallOverride | null> {
		const override = this.overrides.get(overrideId);
		return override?.tenantId === tenantId && override.scheduleId === scheduleId
			? this.overrideView(override)
			: null;
	}

	async addOverride(
		tenantId: TenantId,
		override: Omit<OnCallOverride, "tenantId" | "email">,
		audit: AuditEntry,
	): Promise<OverrideAddOutcome> {
		if (!this.owned(tenantId, override.scheduleId)) return { status: "schedule_not_found" };
		if (!this.accounts.hasMemberSync(tenantId, override.userId)) {
			return { status: "member_not_found" };
		}
		const overlaps = [...this.overrides.values()].some(
			(other) =>
				other.tenantId === tenantId &&
				other.scheduleId === override.scheduleId &&
				other.startsAt < override.endsAt &&
				other.endsAt > override.startsAt,
		);
		if (overlaps) return { status: "overlaps" };
		this.accounts.audit.checkSync([audit]);
		const stored = { ...override, tenantId };
		this.overrides.set(stored.id, stored);
		this.accounts.audit.appendSync([audit]);
		return { status: "added", override: this.overrideView(stored) };
	}

	async deleteOverride(
		tenantId: TenantId,
		scheduleId: string,
		overrideId: string,
		audit: AuditEntry,
	): Promise<boolean> {
		const override = this.overrides.get(overrideId);
		if (override?.tenantId !== tenantId || override.scheduleId !== scheduleId) return false;
		this.accounts.audit.checkSync([audit]);
		this.overrides.delete(overrideId);
		this.accounts.audit.appendSync([audit]);
		return true;
	}
}
