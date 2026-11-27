import type { PageQuery } from "../../contract/common";
import type { CreateIncidentRequest, IncidentId } from "../../contract/incidents";
import type { AuditEntry } from "../audit/types";
import type { DeliveryNotice } from "../notifications/types";
import type { Principal, TenantId } from "../shared/identity";
import type { RequestContext } from "../shared/request";
import type { Result } from "../shared/result";
import type { DraftRequest } from "../summaries/types";

export type Incident = {
	id: IncidentId;
	tenantId: TenantId;
	title: string;
	severity: CreateIncidentRequest["severity"];
	status: "open" | "acknowledged" | "resolved";
	createdAt: Date;
	createdBy: string;
	acknowledgedAt: Date | null;
	acknowledgedBy: string | null;
	resolvedAt: Date | null;
	resolvedBy: string | null;
	// Set only on incidents an alert source opened. See docs/features/alert-ingestion.md.
	alertSourceId: string | null;
	dedupKey: string | null;
	alertCount: number;
	lastAlertAt: Date | null;
	// Who owns it, or null. See docs/features/on-call-schedules.md.
	assigneeId: string | null;
	// How many times it was reassigned by hand. Numbers the reassignments' Slack deliveries.
	assignmentCount: number;
	// Written or accepted by a member, or null. See docs/features/ai-summaries.md.
	summary: IncidentSummary | null;
};

export type IncidentSummary = {
	text: string;
	updatedAt: Date;
	updatedBy: string;
	// The AI draft it was accepted from, or null when written by hand.
	draftId: string | null;
};

// A summary change, with a severity change when one was asked for.
export type SummaryChange = {
	summary: IncidentSummary;
	severity: { from: Incident["severity"]; to: Incident["severity"] } | null;
};

export type IncidentPage = { items: Incident[]; total: number };

export type Assignee = { id: string; email: string };

// An incident as the service returns it: with its assignee's email, read now.
export type IncidentView = Incident & { assignee: Assignee | null };

export type IncidentViewPage = { items: IncidentView[]; total: number };

// What a transition expects to still be true, so racing changes cannot both win.
export type IncidentExpectation = { status: Incident["status"]; assigneeId: string | null };

export type ReassignOutcome =
	| { status: "reassigned"; incident: Incident }
	// The new assignee is not a member of the tenant, or was removed meanwhile.
	| { status: "member_not_found" }
	// The incident is gone, resolved, or its assignee changed since it was read.
	| { status: "changed" };

// Only the assignee or an admin may act on an assigned incident. Anyone may act on an
// unassigned one.
export const mayActOn = (incident: Incident, principal: Principal) =>
	incident.assigneeId === null ||
	incident.assigneeId === principal.userId ||
	principal.role === "admin";

export type IncidentChanges = Partial<
	Pick<Incident, "status" | "acknowledgedAt" | "acknowledgedBy" | "resolvedAt" | "resolvedBy">
>;

// Every method takes tenantId first, so a cross-tenant read cannot be written by accident.
// Write methods take the audit entry for their change and store both in one transaction.
// A `notice` adds the change's Slack deliveries to the same transaction.
export interface IncidentRepository {
	create(
		tenantId: TenantId,
		incident: Omit<Incident, "tenantId">,
		audit: AuditEntry[],
		notice?: DeliveryNotice,
		// Queues the incident's first AI summary draft in the same transaction.
		draft?: DraftRequest,
	): Promise<Incident>;
	findById(tenantId: TenantId, id: IncidentId): Promise<Incident | null>;
	list(tenantId: TenantId, page: PageQuery): Promise<IncidentPage>;
	// Applies only while the stored status and assignee still equal `expected`, so two racing
	// changes cannot both win. Returns null when nothing matched.
	update(
		tenantId: TenantId,
		id: IncidentId,
		expected: IncidentExpectation,
		changes: IncidentChanges,
		// Written only when the update applies, like the notice's deliveries.
		audit: AuditEntry,
		notice?: DeliveryNotice,
		// Queues a postmortem draft in the same transaction, when resolving.
		// Spec: docs/features/ai-postmortems.md.
		postmortemDraft?: DraftRequest,
	): Promise<Incident | null>;
	// Sets the summary, and the severity when the change has one, with their audit entries.
	// A severity change applies only while the incident is unresolved and still has the
	// `from` severity, so it cannot race another change. Returns null when nothing matched.
	setSummary(
		tenantId: TenantId,
		id: IncidentId,
		change: SummaryChange,
		audit: AuditEntry[],
	): Promise<Incident | null>;
	// Moves an unresolved incident from `from` to `to`, and counts the reassignment. In one
	// transaction, it checks `to` is still a member (holding them until commit), writes the
	// audit entry, and adds the notice's deliveries numbered by the new assignmentCount.
	reassign(
		tenantId: TenantId,
		id: IncidentId,
		change: { from: string | null; to: string | null },
		audit: AuditEntry,
		notice: DeliveryNotice,
	): Promise<ReassignOutcome>;
}

export interface IncidentService {
	create(
		principal: Principal,
		input: CreateIncidentRequest,
		context?: RequestContext,
	): Promise<Result<IncidentView>>;
	get(principal: Principal, id: IncidentId): Promise<Result<IncidentView>>;
	list(principal: Principal, page: PageQuery): Promise<Result<IncidentViewPage>>;
	acknowledge(
		principal: Principal,
		id: IncidentId,
		context?: RequestContext,
	): Promise<Result<IncidentView>>;
	resolve(
		principal: Principal,
		id: IncidentId,
		context?: RequestContext,
	): Promise<Result<IncidentView>>;
	// Any member may reassign to a member; only an admin may unassign (null).
	assign(
		principal: Principal,
		id: IncidentId,
		assigneeId: string | null,
		context?: RequestContext,
	): Promise<Result<IncidentView>>;
}
