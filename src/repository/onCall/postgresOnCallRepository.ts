import type { Pool, PoolClient } from "pg";
import type { PageQuery } from "../../contract/common";
import type { AuditEntry } from "../../domain/audit/types";
import type {
	MemberRef,
	OnCallOverride,
	OnCallOverridePage,
	OnCallRepository,
	OnCallSchedule,
	OnCallSchedulePage,
	OverrideAddOutcome,
	ScheduleFields,
	ScheduleWriteOutcome,
} from "../../domain/onCall/types";
import type { TenantId } from "../../domain/shared/identity";
import { insertAuditEntries, inTransaction } from "../audit/postgresAuditRepository";
import { publishChange } from "../events/postgresChangePublisher";

// Spec: docs/features/on-call-schedules.md

// The on-call tables key tenants by uuid, so a tenant whose id is not one has no schedules.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Dates and times come back as text in the schedule's own terms, never shifted by the
// server's zone. Participants are read with their current email, in rotation order.
const SCHEDULE_SELECT = `SELECT s.id, s.tenant_id, s.name, s.time_zone,
	to_char(s.handoff_time, 'HH24:MI') AS handoff_time, s.rotation_days,
	to_char(s.starts_on, 'YYYY-MM-DD') AS starts_on, s.is_default, s.created_at,
	COALESCE((
		SELECT json_agg(json_build_object('userId', p.user_id, 'email', u.email) ORDER BY p.position)
		FROM on_call_participants p
		JOIN users u ON u.tenant_id = p.tenant_id AND u.id = p.user_id
		WHERE p.tenant_id = s.tenant_id AND p.schedule_id = s.id
	), '[]'::json) AS participants
	FROM on_call_schedules s`;

type ScheduleRow = {
	id: string;
	tenant_id: string;
	name: string;
	time_zone: string;
	handoff_time: string;
	rotation_days: number;
	starts_on: string;
	is_default: boolean;
	created_at: Date;
	participants: MemberRef[];
};

const toSchedule = (row: ScheduleRow): OnCallSchedule => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	name: row.name,
	timeZone: row.time_zone,
	handoffTime: row.handoff_time,
	rotationDays: row.rotation_days,
	startsOn: row.starts_on,
	isDefault: row.is_default,
	participants: row.participants,
	createdAt: row.created_at,
});

const OVERRIDE_SELECT = `SELECT o.tenant_id, o.id, o.schedule_id, o.user_id, u.email, o.starts_at,
	o.ends_at, o.created_by, o.created_at
	FROM on_call_overrides o
	JOIN users u ON u.tenant_id = o.tenant_id AND u.id = o.user_id`;

type OverrideRow = {
	tenant_id: string;
	id: string;
	schedule_id: string;
	user_id: string;
	email: string;
	starts_at: Date;
	ends_at: Date;
	created_by: string;
	created_at: Date;
};

const toOverride = (row: OverrideRow): OnCallOverride => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	scheduleId: row.schedule_id,
	userId: row.user_id,
	email: row.email,
	startsAt: row.starts_at,
	endsAt: row.ends_at,
	createdBy: row.created_by,
	createdAt: row.created_at,
});

const findSchedule = async (db: Pool | PoolClient, tenantId: TenantId, id: string) => {
	if (!UUID.test(tenantId) || !UUID.test(id)) return null;
	const { rows } = await db.query<ScheduleRow>(
		`${SCHEDULE_SELECT} WHERE s.tenant_id = $1 AND s.id = $2`,
		[tenantId, id],
	);
	return rows[0] ? toSchedule(rows[0]) : null;
};

// Serialises schedule writes per tenant, so default and name checks cannot race. NO KEY
// UPDATE leaves the foreign key checks of other tables on tenants free to run.
const lockTenant = (client: PoolClient, tenantId: TenantId) =>
	client.query("SELECT id FROM tenants WHERE id = $1 FOR NO KEY UPDATE", [tenantId]);

// The indexes of ids that are not members of the tenant. The members found are held until
// commit, so a concurrent removal waits, then removes them from the rotation it wrote.
const missingMembers = async (client: PoolClient, tenantId: TenantId, ids: string[]) => {
	if (ids.length === 0) return [];
	const { rows } = await client.query<{ id: string }>(
		"SELECT id FROM users WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE",
		[tenantId, ids],
	);
	const found = new Set(rows.map((row) => row.id));
	return ids.flatMap((id, index) => (found.has(id) ? [] : [index]));
};

const nameTaken = async (client: PoolClient, tenantId: TenantId, name: string, except: string) => {
	const { rowCount } = await client.query(
		"SELECT 1 FROM on_call_schedules WHERE tenant_id = $1 AND name = $2 AND id <> $3",
		[tenantId, name, except],
	);
	return (rowCount ?? 0) > 0;
};

const clearDefault = (client: PoolClient, tenantId: TenantId, except: string) =>
	client.query(
		"UPDATE on_call_schedules SET is_default = false WHERE tenant_id = $1 AND is_default AND id <> $2",
		[tenantId, except],
	);

const writeParticipants = async (
	client: PoolClient,
	tenantId: TenantId,
	scheduleId: string,
	userIds: string[],
) => {
	await client.query("DELETE FROM on_call_participants WHERE tenant_id = $1 AND schedule_id = $2", [
		tenantId,
		scheduleId,
	]);
	await client.query(
		`INSERT INTO on_call_participants (tenant_id, schedule_id, position, user_id)
		SELECT $1, $2, ordinality - 1, user_id FROM unnest($3::uuid[]) WITH ORDINALITY AS t(user_id, ordinality)`,
		[tenantId, scheduleId, userIds],
	);
};

const COLUMN_OF = {
	name: "name",
	timeZone: "time_zone",
	handoffTime: "handoff_time",
	rotationDays: "rotation_days",
	startsOn: "starts_on",
	isDefault: "is_default",
} as const;

export class PostgresOnCallRepository implements OnCallRepository {
	constructor(private readonly pool: Pool) {}

	async create(
		tenantId: TenantId,
		schedule: ScheduleFields & { createdAt: Date },
		audit: AuditEntry,
	): Promise<ScheduleWriteOutcome> {
		return inTransaction(this.pool, async (client): Promise<ScheduleWriteOutcome> => {
			await lockTenant(client, tenantId);
			// Every check runs before any write, so a refusal changes nothing.
			if (await nameTaken(client, tenantId, schedule.name, schedule.id)) {
				return { status: "name_taken" };
			}
			const missing = await missingMembers(client, tenantId, schedule.participantIds);
			if (missing.length > 0) return { status: "members_not_found", indexes: missing };
			if (schedule.isDefault) await clearDefault(client, tenantId, schedule.id);
			await client.query(
				`INSERT INTO on_call_schedules
					(tenant_id, id, name, time_zone, handoff_time, rotation_days, starts_on, is_default, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					tenantId,
					schedule.id,
					schedule.name,
					schedule.timeZone,
					schedule.handoffTime,
					schedule.rotationDays,
					schedule.startsOn,
					schedule.isDefault,
					schedule.createdAt,
				],
			);
			await writeParticipants(client, tenantId, schedule.id, schedule.participantIds);
			await insertAuditEntries(client, [audit]);
			await publishChange(client, {
				kind: "on_call_schedule",
				tenantId,
				id: schedule.id,
				event: "on_call_schedule.created",
			});
			const saved = await findSchedule(client, tenantId, schedule.id);
			return saved ? { status: "saved", schedule: saved } : { status: "not_found" };
		});
	}

	async update(
		tenantId: TenantId,
		id: string,
		patch: Partial<Omit<ScheduleFields, "id">>,
		audit: (before: OnCallSchedule) => AuditEntry,
	): Promise<ScheduleWriteOutcome> {
		if (!UUID.test(tenantId)) return { status: "not_found" };
		return inTransaction(this.pool, async (client): Promise<ScheduleWriteOutcome> => {
			await lockTenant(client, tenantId);
			const before = await findSchedule(client, tenantId, id);
			if (!before) return { status: "not_found" };
			if (patch.name !== undefined && (await nameTaken(client, tenantId, patch.name, id))) {
				return { status: "name_taken" };
			}
			if (patch.participantIds) {
				const missing = await missingMembers(client, tenantId, patch.participantIds);
				if (missing.length > 0) return { status: "members_not_found", indexes: missing };
			}
			if (patch.isDefault) await clearDefault(client, tenantId, id);

			const keys = (Object.keys(COLUMN_OF) as (keyof typeof COLUMN_OF)[]).filter(
				(key) => patch[key] !== undefined,
			);
			if (keys.length > 0) {
				await client.query(
					`UPDATE on_call_schedules SET ${keys.map((key, index) => `${COLUMN_OF[key]} = $${index + 3}`).join(", ")}
					WHERE tenant_id = $1 AND id = $2`,
					[tenantId, id, ...keys.map((key) => patch[key])],
				);
			}
			if (patch.participantIds) {
				await writeParticipants(client, tenantId, id, patch.participantIds);
			}
			await insertAuditEntries(client, [audit(before)]);
			await publishChange(client, {
				kind: "on_call_schedule",
				tenantId,
				id,
				event: "on_call_schedule.updated",
			});
			const saved = await findSchedule(client, tenantId, id);
			return saved ? { status: "saved", schedule: saved } : { status: "not_found" };
		});
	}

	async delete(
		tenantId: TenantId,
		id: string,
		audit: (deleted: OnCallSchedule) => AuditEntry,
	): Promise<boolean> {
		if (!UUID.test(tenantId)) return false;
		return inTransaction(this.pool, async (client) => {
			await lockTenant(client, tenantId);
			const schedule = await findSchedule(client, tenantId, id);
			if (!schedule) return false;
			// Participants and overrides cascade. Linked alert sources are set to no schedule.
			await client.query("DELETE FROM on_call_schedules WHERE tenant_id = $1 AND id = $2", [
				tenantId,
				id,
			]);
			await insertAuditEntries(client, [audit(schedule)]);
			await publishChange(client, {
				kind: "on_call_schedule",
				tenantId,
				id,
				event: "on_call_schedule.deleted",
			});
			return true;
		});
	}

	findById(tenantId: TenantId, id: string): Promise<OnCallSchedule | null> {
		return findSchedule(this.pool, tenantId, id);
	}

	async findDefault(tenantId: TenantId): Promise<OnCallSchedule | null> {
		if (!UUID.test(tenantId)) return null;
		const { rows } = await this.pool.query<ScheduleRow>(
			`${SCHEDULE_SELECT} WHERE s.tenant_id = $1 AND s.is_default`,
			[tenantId],
		);
		return rows[0] ? toSchedule(rows[0]) : null;
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery): Promise<OnCallSchedulePage> {
		if (!UUID.test(tenantId)) return { items: [], total: 0 };
		const [page, count] = await Promise.all([
			this.pool.query<ScheduleRow>(
				`${SCHEDULE_SELECT} WHERE s.tenant_id = $1 ORDER BY s.name COLLATE "C", s.id LIMIT $2 OFFSET $3`,
				[tenantId, limit, offset],
			),
			this.pool.query<{ total: string }>(
				"SELECT count(*) AS total FROM on_call_schedules WHERE tenant_id = $1",
				[tenantId],
			),
		]);
		return { items: page.rows.map(toSchedule), total: Number(count.rows[0]?.total ?? 0) };
	}

	async overridesFrom(
		tenantId: TenantId,
		scheduleId: string,
		at: Date,
		limit: number,
	): Promise<OnCallOverride[]> {
		if (!UUID.test(tenantId) || !UUID.test(scheduleId)) return [];
		const { rows } = await this.pool.query<OverrideRow>(
			`${OVERRIDE_SELECT} WHERE o.tenant_id = $1 AND o.schedule_id = $2 AND o.ends_at > $3
			ORDER BY o.starts_at, o.id LIMIT $4`,
			[tenantId, scheduleId, at, limit],
		);
		return rows.map(toOverride);
	}

	async listOverrides(
		tenantId: TenantId,
		scheduleId: string,
		from: Date,
		{ limit, offset }: PageQuery,
	): Promise<OnCallOverridePage> {
		if (!UUID.test(tenantId) || !UUID.test(scheduleId)) return { items: [], total: 0 };
		const filter = "o.tenant_id = $1 AND o.schedule_id = $2 AND o.ends_at > $3";
		const [page, count] = await Promise.all([
			this.pool.query<OverrideRow>(
				`${OVERRIDE_SELECT} WHERE ${filter} ORDER BY o.starts_at, o.id LIMIT $4 OFFSET $5`,
				[tenantId, scheduleId, from, limit, offset],
			),
			this.pool.query<{ total: string }>(
				`SELECT count(*) AS total FROM on_call_overrides o WHERE ${filter}`,
				[tenantId, scheduleId, from],
			),
		]);
		return { items: page.rows.map(toOverride), total: Number(count.rows[0]?.total ?? 0) };
	}

	async findOverride(
		tenantId: TenantId,
		scheduleId: string,
		overrideId: string,
	): Promise<OnCallOverride | null> {
		if (!UUID.test(tenantId) || !UUID.test(scheduleId) || !UUID.test(overrideId)) return null;
		const { rows } = await this.pool.query<OverrideRow>(
			`${OVERRIDE_SELECT} WHERE o.tenant_id = $1 AND o.schedule_id = $2 AND o.id = $3`,
			[tenantId, scheduleId, overrideId],
		);
		return rows[0] ? toOverride(rows[0]) : null;
	}

	async addOverride(
		tenantId: TenantId,
		override: Omit<OnCallOverride, "tenantId" | "email">,
		audit: AuditEntry,
	): Promise<OverrideAddOutcome> {
		if (!UUID.test(tenantId)) return { status: "schedule_not_found" };
		return inTransaction(this.pool, async (client): Promise<OverrideAddOutcome> => {
			// The schedule's row lock queues concurrent adds, so the overlap check below sees
			// every override committed before this one.
			const schedule = await client.query(
				"SELECT id FROM on_call_schedules WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
				[tenantId, override.scheduleId],
			);
			if (schedule.rowCount === 0) return { status: "schedule_not_found" };
			const missing = await missingMembers(client, tenantId, [override.userId]);
			if (missing.length > 0) return { status: "member_not_found" };
			const overlap = await client.query(
				`SELECT 1 FROM on_call_overrides
				WHERE tenant_id = $1 AND schedule_id = $2 AND starts_at < $4 AND ends_at > $3 LIMIT 1`,
				[tenantId, override.scheduleId, override.startsAt, override.endsAt],
			);
			if ((overlap.rowCount ?? 0) > 0) return { status: "overlaps" };
			await client.query(
				`INSERT INTO on_call_overrides
					(tenant_id, id, schedule_id, user_id, starts_at, ends_at, created_by, created_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				[
					tenantId,
					override.id,
					override.scheduleId,
					override.userId,
					override.startsAt,
					override.endsAt,
					override.createdBy,
					override.createdAt,
				],
			);
			await insertAuditEntries(client, [audit]);
			await publishChange(client, {
				kind: "on_call_override",
				tenantId,
				scheduleId: override.scheduleId,
				id: override.id,
				event: "on_call_override.created",
			});
			const { rows } = await client.query<OverrideRow>(
				`${OVERRIDE_SELECT} WHERE o.tenant_id = $1 AND o.id = $2`,
				[tenantId, override.id],
			);
			return { status: "added", override: toOverride(rows[0] as OverrideRow) };
		});
	}

	async deleteOverride(
		tenantId: TenantId,
		scheduleId: string,
		overrideId: string,
		audit: AuditEntry,
	): Promise<boolean> {
		if (!UUID.test(tenantId)) return false;
		return inTransaction(this.pool, async (client) => {
			const { rowCount } = await client.query(
				"DELETE FROM on_call_overrides WHERE tenant_id = $1 AND schedule_id = $2 AND id = $3",
				[tenantId, scheduleId, overrideId],
			);
			if (rowCount === 0) return false;
			await insertAuditEntries(client, [audit]);
			await publishChange(client, {
				kind: "on_call_override",
				tenantId,
				scheduleId,
				id: overrideId,
				event: "on_call_override.deleted",
			});
			return true;
		});
	}
}
