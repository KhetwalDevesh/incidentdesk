import type { PageQuery } from "../../contract/common";
import type { CreateIncidentRequest, IncidentId } from "../../contract/incidents";
import type { Principal, TenantId } from "../shared/identity";
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
};

export type IncidentPage = { items: Incident[]; total: number };

export type IncidentChanges = Partial<
	Pick<Incident, "status" | "acknowledgedAt" | "acknowledgedBy">
>;

// Every method takes tenantId first, so a cross-tenant read cannot be written by accident.
export interface IncidentRepository {
	create(tenantId: TenantId, incident: Omit<Incident, "tenantId">): Promise<Incident>;
	findById(tenantId: TenantId, id: IncidentId): Promise<Incident | null>;
	list(tenantId: TenantId, page: PageQuery): Promise<IncidentPage>;
	// Applies only while the stored status still equals expectedStatus, so two racing
	// transitions cannot both win. Returns null when nothing matched.
	update(
		tenantId: TenantId,
		id: IncidentId,
		expectedStatus: Incident["status"],
		changes: IncidentChanges,
	): Promise<Incident | null>;
}

export interface IncidentService {
	create(principal: Principal, input: CreateIncidentRequest): Promise<Result<Incident>>;
	get(principal: Principal, id: IncidentId): Promise<Result<Incident>>;
	list(principal: Principal, page: PageQuery): Promise<Result<IncidentPage>>;
	acknowledge(principal: Principal, id: IncidentId): Promise<Result<Incident>>;
}
