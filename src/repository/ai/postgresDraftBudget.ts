import type { PoolClient } from "pg";
import type { TenantId } from "../../domain/shared/identity";

// The daily AI budget shared by summary and postmortem drafts. Spec:
// docs/features/ai-summaries.md and docs/features/ai-postmortems.md.

// Serialises a tenant's draft creation until commit, so concurrent requests of either kind
// cannot pass the cap together.
export const lockDraftBudget = (client: PoolClient, tenantId: TenantId) =>
	client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ai_drafts:${tenantId}`]);

// Drafts of both kinds the tenant has sent, or will send, to the model since `since`.
export const draftsUsedSince = async (client: PoolClient, tenantId: TenantId, since: Date) => {
	const { rows } = await client.query<{ count: number }>(
		`SELECT (
			(SELECT count(*) FROM incident_summary_drafts
				WHERE tenant_id = $1 AND created_at >= $2 AND state <> 'skipped')
			+ (SELECT count(*) FROM incident_postmortem_drafts
				WHERE tenant_id = $1 AND created_at >= $2 AND state <> 'skipped')
		)::int AS count`,
		[tenantId, since],
	);
	return rows[0]?.count ?? 0;
};
