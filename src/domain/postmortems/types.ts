import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type {
	POSTMORTEM_STATES,
	PostmortemContent,
	SavePostmortemRequest,
} from "../../contract/postmortems";
import type { AuditEntry } from "../audit/types";
import type { Principal, TenantId } from "../shared/identity";
import type { RequestContext } from "../shared/request";
import type { Result } from "../shared/result";
import type { DraftRequest, SummaryDraftState, SummaryFailureReason } from "../summaries/types";

// Spec: docs/features/ai-postmortems.md. Drafts work exactly like summary drafts.

export type PostmortemDraft = {
	id: string;
	tenantId: TenantId;
	incidentId: IncidentId;
	state: SummaryDraftState;
	content: PostmortemContent | null;
	model: string | null;
	failureReason: SummaryFailureReason | null;
	requestedBy: string | null;
	attempts: number;
	nextAttemptAt: Date;
	// Never returned by the API.
	inputTokens: number | null;
	outputTokens: number | null;
	lastError: string | null;
	createdAt: Date;
	completedAt: Date | null;
};

export type PostmortemDraftPage = { items: PostmortemDraft[]; total: number };

export type PostmortemDraftOutcome =
	| {
			state: "ready";
			content: PostmortemContent;
			model: string;
			inputTokens: number | null;
			outputTokens: number | null;
	  }
	| { state: "failed" | "skipped"; failureReason: SummaryFailureReason; error: string | null };

// Tenant-scoped, apart from claim, which serves every tenant. Audit every caller of claim.
// The daily cap is shared with summary drafts, under the same per-tenant lock.
export interface PostmortemDraftRepository {
	request(tenantId: TenantId, draft: DraftRequest): Promise<PostmortemDraft>;
	findById(tenantId: TenantId, id: string): Promise<PostmortemDraft | null>;
	list(tenantId: TenantId, incidentId: IncidentId, page: PageQuery): Promise<PostmortemDraftPage>;
	claim(now: Date, leaseUntil: Date, limit: number): Promise<PostmortemDraft[]>;
	complete(
		tenantId: TenantId,
		id: string,
		outcome: PostmortemDraftOutcome,
		at: Date,
	): Promise<PostmortemDraft | null>;
	retry(tenantId: TenantId, id: string, retryAt: Date, error: string): Promise<void>;
}

export type PostmortemState = (typeof POSTMORTEM_STATES)[number];

export type Postmortem = {
	tenantId: TenantId;
	incidentId: IncidentId;
	body: string;
	state: PostmortemState;
	draftId: string | null;
	updatedAt: Date;
	updatedBy: string;
	publishedAt: Date | null;
	publishedBy: string | null;
};

// Tenant-scoped. Every write announces the change and writes its audit entry with it.
export interface PostmortemRepository {
	find(tenantId: TenantId, incidentId: IncidentId): Promise<Postmortem | null>;
	// Creates or replaces the body. A published postmortem stays published.
	save(
		tenantId: TenantId,
		incidentId: IncidentId,
		change: { body: string; draftId: string | null; updatedBy: string; updatedAt: Date },
		audit: AuditEntry,
	): Promise<Postmortem>;
	// Marks it published. Already published, or no postmortem: nothing is written, and the
	// postmortem (or null) is returned.
	publish(
		tenantId: TenantId,
		incidentId: IncidentId,
		by: string,
		at: Date,
		audit: AuditEntry,
	): Promise<Postmortem | null>;
}

export interface PostmortemService {
	requestDraft(
		principal: Principal,
		incidentId: IncidentId,
		context?: RequestContext,
	): Promise<Result<PostmortemDraft>>;
	listDrafts(
		principal: Principal,
		incidentId: IncidentId,
		page: PageQuery,
	): Promise<Result<PostmortemDraftPage>>;
	get(principal: Principal, incidentId: IncidentId): Promise<Result<Postmortem>>;
	save(
		principal: Principal,
		incidentId: IncidentId,
		input: SavePostmortemRequest,
		context?: RequestContext,
	): Promise<Result<Postmortem>>;
	publish(
		principal: Principal,
		incidentId: IncidentId,
		context?: RequestContext,
	): Promise<Result<Postmortem>>;
}

export interface PostmortemProcessor {
	// Claims due postmortem drafts and works them. Returns how many it claimed.
	process(): Promise<number>;
}
