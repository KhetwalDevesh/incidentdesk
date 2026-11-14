import type { Pool, PoolClient } from "pg";
import type { PageQuery } from "../../contract/common";
import type {
	AccountRepository,
	CredentialStore,
	NewSetupToken,
	Tenant,
	User,
	UserPage,
} from "../../domain/auth/types";
import type { Role, TenantId } from "../../domain/shared/identity";

const USER_COLUMNS = "id, tenant_id, email, role, password_hash, created_at";

type UserRow = {
	id: string;
	tenant_id: string;
	email: string;
	role: Role;
	password_hash: string | null;
	created_at: Date;
};

const toUser = (row: UserRow): User => ({
	id: row.id,
	tenantId: row.tenant_id as TenantId,
	email: row.email,
	role: row.role,
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

	async createTenantWithAdmin(tenant: Tenant, admin: Omit<User, "tenantId">): Promise<boolean> {
		return this.transaction(async (client) => {
			await client.query("INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, $3)", [
				tenant.id,
				tenant.name,
				tenant.createdAt,
			]);
			const { rowCount } = await client.query(INSERT_USER, userValues(tenant.id, admin));
			return rowCount === 1;
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
	async redeemSetupToken(tokenHash: string, now: Date, passwordHash: string): Promise<User | null> {
		const { rows } = await this.pool.query<UserRow>(
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
		return rows[0] ? toUser(rows[0]) : null;
	}

	async findUser(tenantId: TenantId, userId: string): Promise<User | null> {
		const { rows } = await this.pool.query<UserRow>(
			`SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = $1 AND id = $2`,
			[tenantId, userId],
		);
		return rows[0] ? toUser(rows[0]) : null;
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
	): Promise<boolean> {
		return this.transaction(async (client) => {
			const { rowCount } = await client.query(INSERT_USER, userValues(tenantId, user));
			if (rowCount !== 1) return false;
			await client.query(
				"INSERT INTO password_setup_tokens (token_hash, tenant_id, user_id, expires_at) VALUES ($1, $2, $3, $4)",
				[setupToken.tokenHash, tenantId, user.id, setupToken.expiresAt],
			);
			return true;
		});
	}
}
