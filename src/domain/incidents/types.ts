import type { PageQuery } from "../../contract/common";
import type { CreateIncidentRequest, IncidentId } from "../../contract/incidents";
import type { AuditEntry } from "../audit/types";
import type { Principal, TenantId } from "../shared/identity";
import type { RequestContext } from "../shared/request";
import type { Result } from "../shared/result";

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
};

export type IncidentPage = { items: Incident[]; total: number };

export type IncidentChanges = Partial<
	Pick<Incident, "status" | "acknowledgedAt" | "acknowledgedBy" | "resolvedAt" | "resolvedBy">
>;

// Every method takes tenantId first, so a cross-tenant read cannot be written by accident.
// Write methods take the audit entry for their change and store both in one transaction.
export interface IncidentRepository {
	create(
		tenantId: TenantId,
		incident: Omit<Incident, "tenantId">,
		audit: AuditEntry,
	): Promise<Incident>;
	findById(tenantId: TenantId, id: IncidentId): Promise<Incident | null>;
	list(tenantId: TenantId, page: PageQuery): Promise<IncidentPage>;
	// Applies only while the stored status still equals expectedStatus, so two racing
	// transitions cannot both win. Returns null when nothing matched.
	update(
		tenantId: TenantId,
		id: IncidentId,
		expectedStatus: Incident["status"],
		changes: IncidentChanges,
		// Written only when the update applies.
		audit: AuditEntry,
	): Promise<Incident | null>;
}

export interface IncidentService {
	create(
		principal: Principal,
		input: CreateIncidentRequest,
		context?: RequestContext,
	): Promise<Result<Incident>>;
	get(principal: Principal, id: IncidentId): Promise<Result<Incident>>;
	list(principal: Principal, page: PageQuery): Promise<Result<IncidentPage>>;
	acknowledge(
		principal: Principal,
		id: IncidentId,
		context?: RequestContext,
	): Promise<Result<Incident>>;
	resolve(
		principal: Principal,
		id: IncidentId,
		context?: RequestContext,
	): Promise<Result<Incident>>;
}
