import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type {
	PostmortemDraft,
	PostmortemDraftOutcome,
	PostmortemDraftPage,
	PostmortemDraftRepository,
} from "../../domain/postmortems/types";
import type { TenantId } from "../../domain/shared/identity";
import { type DraftRequest, utcDayStart } from "../../domain/summaries/types";
import type { InMemoryDraftBudget } from "../ai/inMemoryDraftBudget";
import type { InMemoryChangeFeed } from "../events/inMemoryChangeFeed";

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The twin of the Postgres repository. Shares the daily budget with summary drafts.
export class InMemoryPostmortemDraftRepository implements PostmortemDraftRepository {
	private readonly drafts = new Map<string, PostmortemDraft>();

	constructor(
		readonly feed: InMemoryChangeFeed,
		private readonly budget: InMemoryDraftBudget,
	) {
		budget.register(
			(tenantId, since) =>
				[...this.drafts.values()].filter(
					(each) =>
						each.tenantId === tenantId && each.createdAt >= since && each.state !== "skipped",
				).length,
		);
	}

	insertSync(tenantId: TenantId, draft: DraftRequest): PostmortemDraft {
		const pending = [...this.drafts.values()].find(
			(each) =>
				each.tenantId === tenantId &&
				each.incidentId === draft.incidentId &&
				each.state === "pending",
		);
		if (pending) return pending;
		const overCap =
			this.budget.usedSinceSync(tenantId, utcDayStart(draft.createdAt)) >= draft.dailyCap;
		const stored: PostmortemDraft = {
			id: draft.id,
			tenantId,
			incidentId: draft.incidentId,
			state: overCap ? "skipped" : "pending",
			content: null,
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
				kind: "postmortem_draft",
				tenantId,
				incidentId: draft.incidentId,
				id: draft.id,
			});
		}
		return stored;
	}

	async request(tenantId: TenantId, draft: DraftRequest): Promise<PostmortemDraft> {
		return this.insertSync(tenantId, draft);
	}

	async findById(tenantId: TenantId, id: string): Promise<PostmortemDraft | null> {
		const draft = this.drafts.get(id);
		return draft?.tenantId === tenantId ? draft : null;
	}

	async list(
		tenantId: TenantId,
		incidentId: IncidentId,
		{ limit, offset }: PageQuery,
	): Promise<PostmortemDraftPage> {
		const matching = [...this.drafts.values()]
			.filter((draft) => draft.tenantId === tenantId && draft.incidentId === incidentId)
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIds(a.id, b.id));
		return { items: matching.slice(offset, offset + limit), total: matching.length };
	}

	async claim(now: Date, leaseUntil: Date, limit: number): Promise<PostmortemDraft[]> {
		return [...this.drafts.values()]
			.filter((draft) => draft.state === "pending" && draft.nextAttemptAt <= now)
			.sort(
				(a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || compareIds(a.id, b.id),
			)
			.slice(0, limit)
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
		outcome: PostmortemDraftOutcome,
		at: Date,
	): Promise<PostmortemDraft | null> {
		const current = this.drafts.get(id);
		if (current?.tenantId !== tenantId || current.state !== "pending") return null;
		const done: PostmortemDraft =
			outcome.state === "ready"
				? {
						...current,
						state: "ready",
						content: outcome.content,
						model: outcome.model,
						inputTokens: outcome.inputTokens,
						outputTokens: outcome.outputTokens,
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
		this.feed.publishSync({ kind: "postmortem_draft", tenantId, incidentId: done.incidentId, id });
		return done;
	}

	async retry(tenantId: TenantId, id: string, retryAt: Date, error: string): Promise<void> {
		const current = this.drafts.get(id);
		if (current?.tenantId !== tenantId || current.state !== "pending") return;
		this.drafts.set(id, { ...current, nextAttemptAt: retryAt, lastError: error });
	}
}
