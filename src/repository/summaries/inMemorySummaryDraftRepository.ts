import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type { TenantId } from "../../domain/shared/identity";
import {
	type DraftOutcome,
	type DraftRequest,
	type SummaryDraft,
	type SummaryDraftPage,
	type SummaryDraftRepository,
	utcDayStart,
} from "../../domain/summaries/types";
import { InMemoryChangeFeed } from "../events/inMemoryChangeFeed";

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The twin of the Postgres repository. Incident repositories call insertSync inside their own
// change, with no await in between, so the two are atomic like one transaction.
export class InMemorySummaryDraftRepository implements SummaryDraftRepository {
	private readonly drafts = new Map<string, SummaryDraft>();

	constructor(readonly feed: InMemoryChangeFeed = new InMemoryChangeFeed()) {}

	insertSync(tenantId: TenantId, draft: DraftRequest): SummaryDraft {
		const owned = [...this.drafts.values()].filter((each) => each.tenantId === tenantId);
		const pending = owned.find(
			(each) => each.incidentId === draft.incidentId && each.state === "pending",
		);
		if (pending) return pending;
		const dayStart = utcDayStart(draft.createdAt);
		const counted = owned.filter(
			(each) => each.createdAt >= dayStart && each.state !== "skipped",
		).length;
		const overCap = counted >= draft.dailyCap;
		const stored: SummaryDraft = {
			id: draft.id,
			tenantId,
			incidentId: draft.incidentId,
			state: overCap ? "skipped" : "pending",
			summary: null,
			suggestedSeverity: null,
			rationale: null,
			model: null,
			failureReason: overCap ? "over_daily_cap" : null,
			requestedBy: draft.requestedBy,
			attempts: 0,
			nextAttemptAt: draft.createdAt,
			inputTokens: null,
			outputTokens: null,
			lastError: null,
			createdAt: draft.createdAt,
			completedAt: overCap ? draft.createdAt : null,
		};
		this.drafts.set(stored.id, stored);
		if (overCap) {
			this.feed.publishSync({
				kind: "summary_draft",
				tenantId,
				incidentId: draft.incidentId,
				id: draft.id,
			});
		}
		return stored;
	}

	async request(tenantId: TenantId, draft: DraftRequest): Promise<SummaryDraft> {
		return this.insertSync(tenantId, draft);
	}

	async findById(tenantId: TenantId, id: string): Promise<SummaryDraft | null> {
		const draft = this.drafts.get(id);
		return draft?.tenantId === tenantId ? draft : null;
	}

	async list(
		tenantId: TenantId,
		incidentId: IncidentId,
		{ limit, offset }: PageQuery,
	): Promise<SummaryDraftPage> {
		const matching = [...this.drafts.values()]
			.filter((draft) => draft.tenantId === tenantId && draft.incidentId === incidentId)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIds(a.id, b.id));
		return { items: matching.slice(offset, offset + limit), total: matching.length };
	}

	async claim(now: Date, leaseUntil: Date, limit: number): Promise<SummaryDraft[]> {
		const due = [...this.drafts.values()]
			.filter((draft) => draft.state === "pending" && draft.nextAttemptAt <= now)
			.sort(
				(a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || compareIds(a.id, b.id),
			)
			.slice(0, limit);
		return due
			.map((draft) => {
				const claimed = { ...draft, attempts: draft.attempts + 1, nextAttemptAt: leaseUntil };
				this.drafts.set(draft.id, claimed);
				return claimed;
			})
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a.id, b.id));
	}

	async complete(
		tenantId: TenantId,
		id: string,
		outcome: DraftOutcome,
		at: Date,
	): Promise<SummaryDraft | null> {
		const current = this.drafts.get(id);
		if (current?.tenantId !== tenantId || current.state !== "pending") return null;
		const done: SummaryDraft =
			outcome.state === "ready"
				? {
						...current,
						state: "ready",
						summary: outcome.summary,
						suggestedSeverity: outcome.suggestedSeverity,
						rationale: outcome.rationale,
						model: outcome.model,
						inputTokens: outcome.inputTokens,
						outputTokens: outcome.outputTokens,
						// A ready draft carries no stale error from an earlier attempt.
						lastError: null,
						completedAt: at,
					}
				: {
						...current,
						state: outcome.state,
						failureReason: outcome.failureReason,
						lastError: outcome.error,
						completedAt: at,
					};
		this.drafts.set(id, done);
		this.feed.publishSync({ kind: "summary_draft", tenantId, incidentId: done.incidentId, id });
		return done;
	}

	async retry(tenantId: TenantId, id: string, retryAt: Date, error: string): Promise<void> {
		const current = this.drafts.get(id);
		if (current?.tenantId !== tenantId || current.state !== "pending") return;
		this.drafts.set(id, { ...current, nextAttemptAt: retryAt, lastError: error });
	}
}
