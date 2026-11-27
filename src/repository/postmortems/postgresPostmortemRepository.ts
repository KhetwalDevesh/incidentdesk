import type { Pool } from "pg";
import type { IncidentId } from "../../contract/incidents";
import type { AuditEntry } from "../../domain/audit/types";
import type { Postmortem, PostmortemRepository } from "../../domain/postmortems/types";
import type { TenantId } from "../../domain/shared/identity";
import { insertAuditEntries, inTransaction } from "../audit/postgresAuditRepository";
import { publishChange } from "../events/postgresChangePublisher";

// Spec: docs/features/ai-postmortems.md, "The postmortem document".

const COLUMNS =
	"tenant_id, incident_id, body, state, draft_id, updated_by, updated_at, published_by, published_at";

type PostmortemRow = {
	tenant_id: string;
	incident_id: string;
	body: string;
	state: Postmortem["state"];
	draft_id: string | null;
	updated_by: string;
	updated_at: Date;
	published_by: string | null;
	published_at: Date | null;
};

const toPostmortem = (row: PostmortemRow): Postmortem => ({
	tenantId: row.tenant_id as TenantId,
	incidentId: row.incident_id as IncidentId,
	body: row.body,
	state: row.state,
	draftId: row.draft_id,
	updatedBy: row.updated_by,
	updatedAt: row.updated_at,
	publishedBy: row.published_by,
	publishedAt: row.published_at,
});

export class PostgresPostmortemRepository implements PostmortemRepository {
	constructor(private readonly pool: Pool) {}

	async find(tenantId: TenantId, incidentId: IncidentId): Promise<Postmortem | null> {
		const { rows } = await this.pool.query<PostmortemRow>(
			`SELECT ${COLUMNS} FROM incident_postmortems WHERE tenant_id = $1 AND incident_id = $2`,
			[tenantId, incidentId],
		);
		return rows[0] ? toPostmortem(rows[0]) : null;
	}

	// One statement creates or replaces it, so two saves at once both apply: the last wins.
	async save(
		tenantId: TenantId,
		incidentId: IncidentId,
		change: { body: string; draftId: string | null; updatedBy: string; updatedAt: Date },
		audit: AuditEntry,
	): Promise<Postmortem> {
		return inTransaction(this.pool, async (client) => {
			const { rows } = await client.query<PostmortemRow>(
				`INSERT INTO incident_postmortems
					(tenant_id, incident_id, body, state, draft_id, updated_by, updated_at)
				VALUES ($1, $2, $3, 'draft', $4, $5, $6)
				ON CONFLICT (tenant_id, incident_id) DO UPDATE SET
					body = EXCLUDED.body, draft_id = EXCLUDED.draft_id,
					updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
				RETURNING ${COLUMNS}`,
				[tenantId, incidentId, change.body, change.draftId, change.updatedBy, change.updatedAt],
			);
			await insertAuditEntries(client, [audit]);
			await publishChange(client, { kind: "postmortem", tenantId, incidentId });
			return toPostmortem(rows[0] as PostmortemRow);
		});
	}

	async publish(
		tenantId: TenantId,
		incidentId: IncidentId,
		by: string,
		at: Date,
		audit: AuditEntry,
	): Promise<Postmortem | null> {
		return inTransaction(this.pool, async (client) => {
			const { rows } = await client.query<PostmortemRow>(
				`UPDATE incident_postmortems SET state = 'published', published_by = $3, published_at = $4
				WHERE tenant_id = $1 AND incident_id = $2 AND state = 'draft'
				RETURNING ${COLUMNS}`,
				[tenantId, incidentId, by, at],
			);
			if (rows[0]) {
				await insertAuditEntries(client, [audit]);
				await publishChange(client, { kind: "postmortem", tenantId, incidentId });
				return toPostmortem(rows[0]);
			}
			// Already published, or none: nothing changes.
			const current = await client.query<PostmortemRow>(
				`SELECT ${COLUMNS} FROM incident_postmortems WHERE tenant_id = $1 AND incident_id = $2`,
				[tenantId, incidentId],
			);
			return current.rows[0] ? toPostmortem(current.rows[0]) : null;
		});
	}
}
