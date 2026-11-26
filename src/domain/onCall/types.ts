import type { PageQuery } from "../../contract/common";
import type {
	CreateOnCallOverrideRequest,
	CreateOnCallScheduleRequest,
	ON_CALL_SOURCES,
	OnCallOverrideListQuery,
	UpdateOnCallScheduleRequest,
} from "../../contract/onCall";
import type { AuditEntry } from "../audit/types";
import type { Principal, TenantId } from "../shared/identity";
import type { RequestContext } from "../shared/request";
import type { Result } from "../shared/result";

// Spec: docs/features/on-call-schedules.md

// A member as a schedule shows them. The email is read from the member, never copied.
export type MemberRef = { userId: string; email: string };

export type OnCallSchedule = {
	id: string;
	tenantId: TenantId;
	name: string;
	// An IANA zone, such as Europe/London.
	timeZone: string;
	// HH:MM, local to timeZone.
	handoffTime: string;
	rotationDays: number;
	// YYYY-MM-DD, local to timeZone.
	startsOn: string;
	isDefault: boolean;
	// The rotation, in order.
	participants: MemberRef[];
	createdAt: Date;
};

export type OnCallSchedulePage = { items: OnCallSchedule[]; total: number };

export type OnCallOverride = {
	id: string;
	tenantId: TenantId;
	scheduleId: string;
	userId: string;
	email: string;
	startsAt: Date;
	endsAt: Date;
	createdBy: string;
	createdAt: Date;
};

export type OnCallOverridePage = { items: OnCallOverride[]; total: number };

export type OnCallSource = (typeof ON_CALL_SOURCES)[number];

// Who is on call at a time, from when, and until the next change.
export type OnCallShift = MemberRef & { source: OnCallSource; from: Date; until: Date };

// What a schedule write stores. Participants are member ids, in order.
export type ScheduleFields = Omit<OnCallSchedule, "tenantId" | "participants" | "createdAt"> & {
	participantIds: string[];
};

export type ScheduleWriteOutcome =
	| { status: "saved"; schedule: OnCallSchedule }
	| { status: "not_found" }
	| { status: "name_taken" }
	// Indexes into participantIds of ids that are not members of the tenant.
	| { status: "members_not_found"; indexes: number[] };

export type OverrideAddOutcome =
	| { status: "added"; override: OnCallOverride }
	| { status: "schedule_not_found" }
	| { status: "member_not_found" }
	| { status: "overlaps" };

// Tenant-scoped. Every method takes tenantId first, like every repository.
// Schedule writes hold a per-tenant lock, so two requests setting the default cannot both win.
export interface OnCallRepository {
	create(
		tenantId: TenantId,
		schedule: ScheduleFields & { createdAt: Date },
		audit: AuditEntry,
	): Promise<ScheduleWriteOutcome>;
	// Replaces the fields given. A participantIds list replaces the whole rotation.
	update(
		tenantId: TenantId,
		id: string,
		patch: Partial<Omit<ScheduleFields, "id">>,
		// Built from the schedule as it was, so the entry names it.
		audit: (before: OnCallSchedule) => AuditEntry,
	): Promise<ScheduleWriteOutcome>;
	// Deletes the schedule, its rotation and overrides, and unlinks its alert sources.
	delete(
		tenantId: TenantId,
		id: string,
		audit: (deleted: OnCallSchedule) => AuditEntry,
	): Promise<boolean>;
	findById(tenantId: TenantId, id: string): Promise<OnCallSchedule | null>;
	findDefault(tenantId: TenantId): Promise<OnCallSchedule | null>;
	// By name.
	list(tenantId: TenantId, page: PageQuery): Promise<OnCallSchedulePage>;
	// Overrides ending after `at`, by start time. Bounded by `limit`.
	overridesFrom(
		tenantId: TenantId,
		scheduleId: string,
		at: Date,
		limit: number,
	): Promise<OnCallOverride[]>;
	listOverrides(
		tenantId: TenantId,
		scheduleId: string,
		from: Date,
		page: PageQuery,
	): Promise<OnCallOverridePage>;
	findOverride(
		tenantId: TenantId,
		scheduleId: string,
		overrideId: string,
	): Promise<OnCallOverride | null>;
	// Locks the schedule, then refuses an overlap with another override in it.
	addOverride(
		tenantId: TenantId,
		override: Omit<OnCallOverride, "tenantId" | "email">,
		audit: AuditEntry,
	): Promise<OverrideAddOutcome>;
	deleteOverride(
		tenantId: TenantId,
		scheduleId: string,
		overrideId: string,
		audit: AuditEntry,
	): Promise<boolean>;
}

// Picks an incident's assignee when it opens: from the given schedule, or the tenant's
// default when none is given. Null when there is no such schedule or nobody is on call.
export interface OnCallAssigner {
	assigneeFor(tenantId: TenantId, scheduleId: string | null, at: Date): Promise<MemberRef | null>;
}

export interface OnCallScheduleService {
	create(
		principal: Principal,
		input: CreateOnCallScheduleRequest,
		context?: RequestContext,
	): Promise<Result<OnCallSchedule>>;
	list(principal: Principal, page: PageQuery): Promise<Result<OnCallSchedulePage>>;
	get(principal: Principal, id: string): Promise<Result<OnCallSchedule>>;
	update(
		principal: Principal,
		id: string,
		input: UpdateOnCallScheduleRequest,
		context?: RequestContext,
	): Promise<Result<OnCallSchedule>>;
	delete(principal: Principal, id: string, context?: RequestContext): Promise<Result<void>>;
	onCall(principal: Principal, id: string, at: Date | null): Promise<Result<OnCallAt>>;
	addOverride(
		principal: Principal,
		scheduleId: string,
		input: CreateOnCallOverrideRequest,
		context?: RequestContext,
	): Promise<Result<OnCallOverride>>;
	listOverrides(
		principal: Principal,
		scheduleId: string,
		query: OnCallOverrideListQuery,
	): Promise<Result<OnCallOverridePage>>;
	deleteOverride(
		principal: Principal,
		scheduleId: string,
		overrideId: string,
		context?: RequestContext,
	): Promise<Result<void>>;
}

export type OnCallAt = { at: Date; onCall: OnCallShift | null };
