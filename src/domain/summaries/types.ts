import type { PageQuery } from "../../contract/common";
import type { IncidentId, IncidentSeverity } from "../../contract/incidents";
import type {
	SetSummaryRequest,
	SUMMARY_DRAFT_STATES,
	SUMMARY_FAILURE_REASONS,
} from "../../contract/summaries";
import type { IncidentView } from "../incidents/types";
import type { Principal, TenantId } from "../shared/identity";
import type { RequestContext } from "../shared/request";
import type { Result } from "../shared/result";

// Spec: docs/features/ai-summaries.md

export type SummaryDraftState = (typeof SUMMARY_DRAFT_STATES)[number];
export type SummaryFailureReason = (typeof SUMMARY_FAILURE_REASONS)[number];

export type SummaryDraft = {
	id: string;
	tenantId: TenantId;
	incidentId: IncidentId;
	state: SummaryDraftState;
	summary: string | null;
	suggestedSeverity: IncidentSeverity | null;
	rationale: string | null;
	model: string | null;
	failureReason: SummaryFailureReason | null;
	// A member id, or null for a draft made when the incident opened.
	requestedBy: string | null;
	attempts: number;
	// When a pending draft is next due. While an attempt runs, the end of its lease.
	nextAttemptAt: Date;
	// Never returned by the API.
	inputTokens: number | null;
	outputTokens: number | null;
	lastError: string | null;
	createdAt: Date;
	completedAt: Date | null;
};

export type SummaryDraftPage = { items: SummaryDraft[]; total: number };

// A draft to queue: pending, or skipped at once when the tenant's daily cap is reached.
export type DraftRequest = {
	id: string;
	incidentId: IncidentId;
	requestedBy: string | null;
	createdAt: Date;
	// Drafts a tenant may send to the AI per UTC day.
	dailyCap: number;
};

// How an attempt ended.
export type DraftOutcome =
	| {
			state: "ready";
			summary: string;
			suggestedSeverity: IncidentSeverity;
			rationale: string;
			model: string;
			inputTokens: number | null;
			outputTokens: number | null;
	  }
	| {
			state: "failed" | "skipped";
			failureReason: SummaryFailureReason;
			// A fixed description, never the provider's message or prompt text.
			error: string | null;
	  };

// The start of the UTC day containing `at`, from which the daily cap counts.
export const utcDayStart = (at: Date) =>
	new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

// Tenant-scoped, apart from claim, which serves every tenant. Audit every caller of claim.
export interface SummaryDraftRepository {
	// Queues a draft, in its own transaction. Returns the incident's pending draft instead if
	// it has one. Under a per-tenant lock, so concurrent requests cannot pass the daily cap.
	request(tenantId: TenantId, draft: DraftRequest): Promise<SummaryDraft>;
	findById(tenantId: TenantId, id: string): Promise<SummaryDraft | null>;
	// Newest first.
	list(tenantId: TenantId, incidentId: IncidentId, page: PageQuery): Promise<SummaryDraftPage>;
	// Claims up to `limit` due pending drafts across every tenant, oldest due first: counts an
	// attempt and holds each until `leaseUntil`, so a crashed attempt comes back after it.
	claim(now: Date, leaseUntil: Date, limit: number): Promise<SummaryDraft[]>;
	// Finishes a pending draft and announces it. Null when it is no longer pending.
	complete(
		tenantId: TenantId,
		id: string,
		outcome: DraftOutcome,
		at: Date,
	): Promise<SummaryDraft | null>;
	// Schedules another attempt of a pending draft.
	retry(tenantId: TenantId, id: string, retryAt: Date, error: string): Promise<void>;
}

// What the model is asked: a fixed system prompt, the incident as data, and the JSON schema
// its answer must match.
export type SummaryPrompt = {
	system: string;
	user: string;
	schema: { name: string; schema: Record<string, unknown> };
	// The most the answer may use. A ceiling: only tokens used are billed. Free "reasoning"
	// models spend many on thinking first, so these are generous.
	maxOutputTokens?: number;
	// How long one call may take. Must stay under the worker's lease.
	timeoutMs?: number;
};

// One call to the model. The writer never judges the content: the processor validates it.
export type WriterResult =
	| {
			kind: "ok";
			// The raw message text, expected to be JSON.
			content: string;
			model: string;
			inputTokens: number | null;
			outputTokens: number | null;
	  }
	// Worth retrying: rate limits, server errors, timeouts, lost connections.
	| { kind: "retry"; error: string }
	// Not worth retrying: a rejected key, an unknown model, a refused request.
	| { kind: "fail"; reason: "provider_error" | "invalid_output"; error: string };

export interface SummaryWriter {
	write(prompt: SummaryPrompt): Promise<WriterResult>;
}

export interface SummaryProcessor {
	// Claims due drafts and works them. Returns how many it claimed.
	process(): Promise<number>;
}

export interface SummaryService {
	requestDraft(
		principal: Principal,
		incidentId: IncidentId,
		context?: RequestContext,
	): Promise<Result<SummaryDraft>>;
	listDrafts(
		principal: Principal,
		incidentId: IncidentId,
		page: PageQuery,
	): Promise<Result<SummaryDraftPage>>;
	setSummary(
		principal: Principal,
		incidentId: IncidentId,
		input: SetSummaryRequest,
		context?: RequestContext,
	): Promise<Result<IncidentView>>;
}
