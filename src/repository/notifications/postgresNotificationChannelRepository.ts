import type { Pool } from "pg";
import type { PageQuery } from "../../contract/common";
import type { AuditEntry } from "../../domain/audit/types";
import type {
	NotificationChannel,
	NotificationChannelPage,
	NotificationChannelRepository,
} from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";
import { insertAuditEntries, inTransaction } from "../audit/postgresAuditRepository";

const COLUMNS =
	"id, tenant_id, kind, name, target_ciphertext, target_hint, min_severity, enabled, created_at";

type ChannelRow = {
	id: string;
	tenant_id: string;
	kind: NotificationChannel["kind"];
	name: string;
	target_ciphertext: Buffer;
	target_hint: string;
	min_severity: NotificationChannel["minSeverity"];
	enabled: boolean;
	created_at: Date;
};

const toChannel = (row: ChannelRow): NotificationChannel => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	kind: row.kind,
	name: row.name,
	targetCiphertext: row.target_ciphertext,
	targetHint: row.target_hint,
	minSeverity: row.min_severity,
	enabled: row.enabled,
	createdAt: row.created_at,
});

export class PostgresNotificationChannelRepository implements NotificationChannelRepository {
	constructor(private readonly pool: Pool) {}

	async create(
		tenantId: TenantId,
		channel: Omit<NotificationChannel, "tenantId">,
		audit: AuditEntry,
	): Promise<NotificationChannel | null> {
		// The unique (tenant_id, name) index decides a duplicate, even under concurrent creates.
		return inTransaction(this.pool, async (client) => {
			const { rows } = await client.query<ChannelRow>(
				`INSERT INTO notification_channels (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (tenant_id, name) DO NOTHING RETURNING ${COLUMNS}`,
				[
					channel.id,
					tenantId,
					channel.kind,
					channel.name,
					Buffer.from(channel.targetCiphertext),
					channel.targetHint,
					channel.minSeverity,
					channel.enabled,
					channel.createdAt,
				],
			);
			if (!rows[0]) return null;
			await insertAuditEntries(client, [audit]);
			return toChannel(rows[0]);
		});
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery): Promise<NotificationChannelPage> {
		const [page, count] = await Promise.all([
			this.pool.query<ChannelRow>(
				`SELECT ${COLUMNS} FROM notification_channels WHERE tenant_id = $1 ORDER BY created_at, id LIMIT $2 OFFSET $3`,
				[tenantId, limit, offset],
			),
			this.pool.query<{ total: string }>(
				"SELECT count(*) AS total FROM notification_channels WHERE tenant_id = $1",
				[tenantId],
			),
		]);
		return { items: page.rows.map(toChannel), total: Number(count.rows[0]?.total ?? 0) };
	}

	async findById(tenantId: TenantId, id: string): Promise<NotificationChannel | null> {
		const { rows } = await this.pool.query<ChannelRow>(
			`SELECT ${COLUMNS} FROM notification_channels WHERE tenant_id = $1 AND id = $2`,
			[tenantId, id],
		);
		return rows[0] ? toChannel(rows[0]) : null;
	}
}
