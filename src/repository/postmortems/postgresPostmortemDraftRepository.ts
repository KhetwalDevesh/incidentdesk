import type { Pool, PoolClient } from "pg";
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
import { draftsUsedSince, lockDraftBudget } from "../ai/postgresDraftBudget";
import { inTransaction } from "../audit/postgresAuditRepository";
import { publishChange } from "../events/postgresChangePublisher";

// Spec: docs/features/ai-postmortems.md. Works like PostgresSummaryDraftRepository.

const COLUMNS =
	"tenant_id, id, incident_id, state, content, model, failure_reason, requested_by, attempts, next_attempt_at, input_tokens, output_tokens, last_error, created_at, completed_at";

type DraftRow = {
	tenant_id: string;
	id: string;
	incident_id: string;
	state: PostmortemDraft["state"];
	content: PostmortemDraft["content"];
	model: string | null;
	failure_reason: PostmortemDraft["failureReason"];
	requested_by: string | null;
	attempts: number;
	next_attempt_at: Date;
	input_tokens: number | null;
	output_tokens: number | null;
	last_error: string | null;
	created_at: Date;
	completed_at: Date | null;
};

const toDraft = (row: DraftRow): PostmortemDraft => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	incidentId: row.incident_id as IncidentId,
	state: row.state,
	content: row.content,
	model: row.model,
	failureReason: row.failure_reason,
	requestedBy: row.requested_by,
	attempts: row.attempts,
	nextAttemptAt: row.next_attempt_at,
	inputTokens: row.input_tokens,
	outputTokens: row.output_tokens,
	lastError: row.last_error,
	createdAt: row.created_at,
	completedAt: row.completed_at,
});

// Queues a draft on the caller's transaction: the resolving change, or a member's request.
// Returns the incident's pending draft instead when it has one.
export const insertPostmortemDraft = async (
	client: PoolClient,
	tenantId: TenantId,
	draft: DraftRequest,
): Promise<PostmortemDraft> => {
	await lockDraftBudget(client, tenantId);
	const pending = await client.query<DraftRow>(
		`SELECT ${COLUMNS} FROM incident_postmortem_drafts
		WHERE tenant_id = $1 AND incident_id = $2 AND state = 'pending'`,
		[tenantId, draft.incidentId],
	);
	if (pending.rows[0]) return toDraft(pending.rows[0]);

	const overCap =
		(await draftsUsedSince(client, tenantId, utcDayStart(draft.createdAt))) >= draft.dailyCap;
	const { rows } = await client.query<DraftRow>(
		`INSERT INTO incident_postmortem_drafts
			(tenant_id, id, incident_id, state, failure_reason, requested_by, attempts, next_attempt_at,
				created_at, completed_at)
		VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7, $8)
		RETURNING ${COLUMNS}`,
		[
			tenantId,
			draft.id,
			draft.incidentId,
			overCap ? "skipped" : "pending",
			overCap ? "over_daily_cap" : null,
			draft.requestedBy,
			draft.createdAt,
			overCap ? draft.createdAt : null,
		],
	);
	if (overCap) {
		await publishChange(client, {
			kind: "postmortem_draft",
			tenantId,
			incidentId: draft.incidentId,
			id: draft.id,
		});
	}
	return toDraft(rows[0] as DraftRow);
};

export class PostgresPostmortemDraftRepository implements PostmortemDraftRepository {
	constructor(private readonly pool: Pool) {}

	request(tenantId: TenantId, draft: DraftRequest): Promise<PostmortemDraft> {
		return inTransaction(this.pool, (client) => insertPostmortemDraft(client, tenantId, draft));
	}

	async findById(tenantId: TenantId, id: string): Promise<PostmortemDraft | null> {
		const { rows } = await this.pool.query<DraftRow>(
			`SELECT ${COLUMNS} FROM incident_postmortem_drafts WHERE tenant_id = $1 AND id = $2`,
			[tenantId, id],
		);
		return rows[0] ? toDraft(rows[0]) : null;
	}

	async list(
		tenantId: TenantId,
		incidentId: IncidentId,
		{ limit, offset }: PageQuery,
	): Promise<PostmortemDraftPage> {
		const [page, count] = await Promise.all([
			this.pool.query<DraftRow>(
				`SELECT ${COLUMNS} FROM incident_postmortem_drafts
				WHERE tenant_id = $1 AND incident_id = $2
				ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
				[tenantId, incidentId, limit, offset],
			),
			this.pool.query<{ total: string }>(
				"SELECT count(*) AS total FROM incident_postmortem_drafts WHERE tenant_id = $1 AND incident_id = $2",
				[tenantId, incidentId],
			),
		]);
		return { items: page.rows.map(toDraft), total: Number(count.rows[0]?.total ?? 0) };
	}

	async claim(now: Date, leaseUntil: Date, limit: number): Promise<PostmortemDraft[]> {
		const { rows } = await this.pool.query<DraftRow>(
			`UPDATE incident_postmortem_drafts SET attempts = attempts + 1, next_attempt_at = $2
			WHERE (tenant_id, id) IN (
				SELECT tenant_id, id FROM incident_postmortem_drafts
				WHERE state = 'pending' AND next_attempt_at <= $1
				ORDER BY next_attempt_at, id
				LIMIT $3
				FOR UPDATE SKIP LOCKED
			)
			RETURNING ${COLUMNS}`,
			[now, leaseUntil, limit],
		);
		return rows
			.map(toDraft)
			.sort(
				(a, b) =>
					a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			);
	}

	async complete(
		tenantId: TenantId,
		id: string,
		outcome: PostmortemDraftOutcome,
		at: Date,
	): Promise<PostmortemDraft | null> {
		return inTransaction(this.pool, async (client) => {
			const ready = outcome.state === "ready" ? outcome : null;
			const failed = outcome.state === "ready" ? null : outcome;
			const { rows } = await client.query<DraftRow>(
				`UPDATE incident_postmortem_drafts SET state = $3, content = $4::jsonb, model = $5,
					input_tokens = $6, output_tokens = $7, failure_reason = $8, last_error = $9,
					completed_at = $10
				WHERE tenant_id = $1 AND id = $2 AND state = 'pending'
				RETURNING ${COLUMNS}`,
				[
					tenantId,
					id,
					outcome.state,
					ready ? JSON.stringify(ready.content) : null,
					ready?.model ?? null,
					ready?.inputTokens ?? null,
					ready?.outputTokens ?? null,
					failed?.failureReason ?? null,
					failed?.error ?? null,
					at,
				],
			);
			const row = rows[0];
			if (!row) return null;
			await publishChange(client, {
				kind: "postmortem_draft",
				tenantId,
				incidentId: row.incident_id,
				id,
			});
			return toDraft(row);
		});
	}

	async retry(tenantId: TenantId, id: string, retryAt: Date, error: string): Promise<void> {
		await this.pool.query(
			`UPDATE incident_postmortem_drafts SET next_attempt_at = $3, last_error = $4
			WHERE tenant_id = $1 AND id = $2 AND state = 'pending'`,
			[tenantId, id, retryAt, error],
		);
	}
}
