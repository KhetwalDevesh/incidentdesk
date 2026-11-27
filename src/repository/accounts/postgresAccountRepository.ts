import type { Pool, PoolClient } from "pg";
import type { PageQuery } from "../../contract/common";
import type { AuditEntry } from "../../domain/audit/types";
import {
	type AccountRepository,
	type CredentialStore,
	keepsActiveAdmin,
	type MemberChangeOutcome,
	type NewSetupToken,
	type RoleChange,
	type Tenant,
	type User,
	type UserPage,
} from "../../domain/auth/types";
import type { Role, TenantId } from "../../domain/shared/identity";
import { insertAuditEntries, inTransaction } from "../audit/postgresAuditRepository";
import { publishChange } from "../events/postgresChangePublisher";

const USER_COLUMNS = "id, tenant_id, email, role, password_hash, created_at";

type UserRow = {
	id: string;
	tenant_id: string;
	email: string;
	// May still be 'viewer' while a deploy rolls out: see migration 0013.
	role: Role | "viewer";
	password_hash: string | null;
	created_at: Date;
};

const toUser = (row: UserRow): User => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	email: row.email,
	// The viewer role is gone. A row an old instance wrote reads as a responder, as 0013 made it.
	role: row.role === "viewer" ? "responder" : row.role,
	passwordHash: row.password_hash,
	createdAt: row.created_at,
});

const INSERT_USER = `INSERT INTO users (${USER_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6)
	ON CONFLICT (email) DO NOTHING RETURNING id`;

const userValues = (tenantId: TenantId, user: Omit<User, "tenantId">) => [
	user.id,
	tenantId,
	user.email,
	user.role,
	user.passwordHash,
	user.createdAt,
];

export class PostgresAccountRepository implements AccountRepository, CredentialStore {
	constructor(private readonly pool: Pool) {}

	// Runs work in one transaction. Work returns false to roll back without an error.
	private async transaction(work: (client: PoolClient) => Promise<boolean>): Promise<boolean> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const commit = await work(client);
			await client.query(commit ? "COMMIT" : "ROLLBACK");
			return commit;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async createTenantWithAdmin(
		tenant: Tenant,
		admin: Omit<User, "tenantId">,
		audit: AuditEntry,
	): Promise<boolean> {
		return this.transaction(async (client) => {
			await client.query("INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, $3)", [
				tenant.id,
				tenant.name,
				tenant.createdAt,
			]);
			const { rowCount } = await client.query(INSERT_USER, userValues(tenant.id, admin));
			if (rowCount !== 1) return false;
			await insertAuditEntries(client, [audit]);
			return true;
		});
	}

	async findUserByEmail(email: string): Promise<User | null> {
		const { rows } = await this.pool.query<UserRow>(
			`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
			[email],
		);
		return rows[0] ? toUser(rows[0]) : null;
	}

	// One statement: the token row lock makes a second concurrent redemption see used_at set.
	// The audit entry joins its transaction once the redeemed user is known.
	async redeemSetupToken(
		tokenHash: string,
		now: Date,
		passwordHash: string,
		audit: (user: User) => AuditEntry,
	): Promise<User | null> {
		return inTransaction(this.pool, async (client) => {
			const { rows } = await client.query<UserRow>(
				`WITH redeemed AS (
				UPDATE password_setup_tokens SET used_at = $2
				WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
				RETURNING tenant_id, user_id
			)
			UPDATE users u SET password_hash = $3
			FROM redeemed r WHERE u.tenant_id = r.tenant_id AND u.id = r.user_id
			RETURNING u.id, u.tenant_id, u.email, u.role, u.password_hash, u.created_at`,
				[tokenHash, now, passwordHash],
			);
			if (!rows[0]) return null;
			const user = toUser(rows[0]);
			await insertAuditEntries(client, [audit(user)]);
			return user;
		});
	}

	async findUser(tenantId: TenantId, userId: string): Promise<User | null> {
		const { rows } = await this.pool.query<UserRow>(
			`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = $1 AND id = $2`,
			[tenantId, userId],
		);
		return rows[0] ? toUser(rows[0]) : null;
	}

	async findUsers(tenantId: TenantId, userIds: string[]): Promise<User[]> {
		if (userIds.length === 0) return [];
		const { rows } = await this.pool.query<UserRow>(
			`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
			[tenantId, [...new Set(userIds)]],
		);
		return rows.map(toUser);
	}

	async listUsers(tenantId: TenantId, { limit, offset }: PageQuery): Promise<UserPage> {
		const [page, count] = await Promise.all([
			this.pool.query<UserRow>(
				`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = $1 ORDER BY created_at, id LIMIT $2 OFFSET $3`,
				[tenantId, limit, offset],
			),
			this.pool.query<{ total: string }>(
				"SELECT count(*) AS total FROM users WHERE tenant_id = $1",
				[tenantId],
			),
		]);
		return { items: page.rows.map(toUser), total: Number(count.rows[0]?.total ?? 0) };
	}

	async addUser(
		tenantId: TenantId,
		user: Omit<User, "tenantId">,
		setupToken: NewSetupToken,
		audit: AuditEntry,
	): Promise<boolean> {
		return this.transaction(async (client) => {
			const { rowCount } = await client.query(INSERT_USER, userValues(tenantId, user));
			if (rowCount !== 1) return false;
			await client.query(
				"INSERT INTO password_setup_tokens (token_hash, tenant_id, user_id, expires_at) VALUES ($1, $2, $3, $4)",
				[setupToken.tokenHash, tenantId, user.id, setupToken.expiresAt],
			);
			await insertAuditEntries(client, [audit]);
			return true;
		});
	}

	async changeRoles(
		tenantId: TenantId,
		changes: RoleChange[],
		audit: (before: User, after: User) => AuditEntry,
	): Promise<MemberChangeOutcome> {
		return inTransaction(this.pool, async (client) => {
			const locked = await lockForMemberChange(
				client,
				tenantId,
				changes.map((change) => change.userId),
			);
			if (!locked.ok) {
				return { applied: false, rejection: { reason: "not_found", indexes: locked.missing } };
			}
			const after = changes.map((change, index) => ({
				...(locked.users[index] as User),
				role: change.role,
			}));
			if (!keepsActiveAdmin(locked.activeAdmins, new Map(after.map((user) => [user.id, user])))) {
				return { applied: false, rejection: { reason: "last_admin" } };
			}
			const entries: AuditEntry[] = [];
			for (const [index, before] of locked.users.entries()) {
				const changed = after[index] as User;
				if (before.role === changed.role) continue;
				await client.query("UPDATE users SET role = $3 WHERE tenant_id = $1 AND id = $2", [
					tenantId,
					changed.id,
					changed.role,
				]);
				entries.push(audit(before, changed));
			}
			await insertAuditEntries(client, entries);
			return { applied: true, users: after };
		});
	}

	async removeUsers(
		tenantId: TenantId,
		userIds: string[],
		audit: (removed: User) => AuditEntry,
	): Promise<MemberChangeOutcome> {
		return inTransaction(this.pool, async (client) => {
			const locked = await lockForMemberChange(client, tenantId, userIds);
			if (!locked.ok) {
				return { applied: false, rejection: { reason: "not_found", indexes: locked.missing } };
			}
			if (!keepsActiveAdmin(locked.activeAdmins, new Map(userIds.map((id) => [id, null])))) {
				return { applied: false, rejection: { reason: "last_admin" } };
			}
			// Their incidents become unassigned, so nobody is stuck behind a missing assignee.
			// incidents.tenant_id is text (see 0002), so there is no foreign key to do it.
			await client.query(
				"UPDATE incidents SET assignee_id = NULL WHERE tenant_id = $1::text AND assignee_id = ANY($2::uuid[])",
				[tenantId, userIds],
			);
			// password_setup_tokens, on-call participants and overrides cascade.
			await client.query("DELETE FROM users WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [
				tenantId,
				userIds,
			]);
			await insertAuditEntries(client, locked.users.map(audit));
			await publishChange(client, { kind: "members_removed", tenantId, userIds });
			return { applied: true, users: locked.users };
		});
	}
}

// Locks the tenant's active admins, then the targeted users, each in id order, so concurrent
// batches queue behind each other instead of deadlocking. A batch that waited sees the
// committed result of the one before it: a deleted row is gone, a demoted admin no longer
// matches. Returns the targets in request order, or the indexes of ids the tenant lacks.
const lockForMemberChange = async (client: PoolClient, tenantId: TenantId, userIds: string[]) => {
	const admins = await client.query<UserRow>(
		`SELECT ${USER_COLUMNS} FROM users
		WHERE tenant_id = $1 AND role = 'admin' AND password_hash IS NOT NULL
		ORDER BY id FOR UPDATE`,
		[tenantId],
	);
	const targets = await client.query<UserRow>(
		`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = $1 AND id = ANY($2::uuid[])
		ORDER BY id FOR UPDATE`,
		[tenantId, userIds],
	);
	const byId = new Map(targets.rows.map((row) => [row.id, toUser(row)]));
	const missing = userIds.flatMap((id, index) => (byId.has(id) ? [] : [index]));
	return missing.length > 0
		? ({ ok: false, missing } as const)
		: ({
				ok: true,
				users: userIds.map((id) => byId.get(id) as User),
				activeAdmins: admins.rows.map(toUser),
			} as const);
};
