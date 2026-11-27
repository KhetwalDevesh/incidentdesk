import { randomUUID } from "node:crypto";
import type { AUDIT_ACTIONS, AUDIT_RESOURCE_TYPES, AuditEventQuery } from "../../contract/audit";
import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type { Principal, TenantId } from "../shared/identity";
import type { RequestContext } from "../shared/request";
import type { Result } from "../shared/result";

// Spec: docs/features/audit-log.md

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

export type AuditActor =
	| { type: "user"; id: string }
	| { type: "alert_source"; id: string }
	// A failed sign-in: nobody proved who they are.
	| { type: "anonymous"; id: null };

export type AuditResource = { type: AuditResourceType; id: string };

// The only details each action may carry. Every role reads the log, so never secrets, tokens,
// webhook URLs or personal data beyond ids.
export type AuditDetails = {
	"tenant.created": { name: string };
	"member.invited": { role: string };
	"member.setup_completed": Record<string, never>;
	"member.role_changed": { from: string; to: string };
	"member.removed": { role: string; status: string };
	"user.login_succeeded": Record<string, never>;
	"user.login_failed": Record<string, never>;
	// Never the email or the IP. Spec: docs/features/login-rate-limiting.md.
	"user.login_locked": Record<string, never>;
	"incident.created": { title: string; severity: string };
	"incident.acknowledged": Record<string, never>;
	"incident.resolved": Record<string, never>;
	// Member ids, or "none". manual is "true" for a reassignment, "false" at opening.
	"incident.assigned": { from: string; to: string; manual: "true" | "false" };
	// Never the summary text, which may quote alert content. draftId is "none" for a summary
	// written by hand. Spec: docs/features/ai-summaries.md.
	"incident.summary_set": { source: "draft" | "manual"; draftId: string };
	"incident.severity_changed": { from: string; to: string };
	"alert.grouped": { alertId: string; dedupKey: string };
	"alert_source.created": { name: string };
	// A schedule id, or "none".
	"alert_source.updated": { onCallScheduleId: string };
	"notification_channel.created": { name: string; type: string };
	"on_call_schedule.created": { name: string };
	// changed lists the request's fields, comma-separated.
	"on_call_schedule.updated": { name: string; changed: string };
	"on_call_schedule.deleted": { name: string };
	// The resource is the schedule. Ids and times only: never the member's email.
	"on_call_override.created": {
		overrideId: string;
		userId: string;
		startsAt: string;
		endsAt: string;
	};
	"on_call_override.deleted": {
		overrideId: string;
		userId: string;
		startsAt: string;
		endsAt: string;
	};
};

export type AuditEntry = {
	id: string;
	tenantId: TenantId;
	occurredAt: Date;
	action: AuditAction;
	actor: AuditActor;
	resource: AuditResource;
	details: Record<string, string>;
	// The request that caused the change. Null for the worker.
	requestId: string | null;
};

// Where an entry came from: the time, a fresh id, and the request, if any.
export type AuditOrigin = { id: string; occurredAt: Date; requestId: string | null };

// A fresh origin for a change made at `occurredAt`, during the given request if any.
export const auditOrigin = (
	occurredAt: Date,
	context?: RequestContext,
	id: string = randomUUID(),
): AuditOrigin => ({ id, occurredAt, requestId: context?.requestId ?? null });

// The one way to build an entry, so each action carries exactly its allowlisted details.
export const auditEntry = <A extends AuditAction>(
	origin: AuditOrigin,
	tenantId: TenantId,
	action: A,
	actor: AuditActor,
	resource: AuditResource,
	details: AuditDetails[A],
): AuditEntry => ({ ...origin, tenantId, action, actor, resource, details });

export const AUDIT_RETENTION_DAYS = 90;
export const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export type AuditPage = { items: AuditEntry[]; total: number };

export type AuditFilter = {
	action?: AuditAction;
	resourceType?: AuditResourceType;
	resourceId?: string;
	actorId?: string;
	from?: Date;
	to?: Date;
};

// Tenant-scoped. Every method takes tenantId first, like every repository.
export interface AuditEventReader {
	// Newest first.
	list(tenantId: TenantId, filter: AuditFilter, page: PageQuery): Promise<AuditPage>;
	// Oldest first: a timeline.
	listForResource(tenantId: TenantId, resource: AuditResource, page: PageQuery): Promise<AuditPage>;
}

// Writes one entry on its own, outside any change. Only for sign-ins, which change nothing.
// Every other entry is written by the repository method that makes the change.
export interface AuditRecorder {
	record(entry: AuditEntry): Promise<void>;
}

// Runs across every tenant: the worker purges them all. Audit every caller.
export interface AuditPurger {
	// Deletes up to `limit` entries older than `cutoff`. Returns how many it deleted.
	purgeOlderThan(cutoff: Date, limit: number): Promise<number>;
}

export interface AuditService {
	list(principal: Principal, query: AuditEventQuery): Promise<Result<AuditPage>>;
	incidentTimeline(
		principal: Principal,
		incidentId: IncidentId,
		page: PageQuery,
	): Promise<Result<AuditPage>>;
}
