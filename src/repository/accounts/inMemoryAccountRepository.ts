import type { PageQuery } from "../../contract/common";
import type { AuditEntry } from "../../domain/audit/types";
import {
	type AccountRepository,
	type CredentialStore,
	isActiveAdmin,
	keepsActiveAdmin,
	type MemberChangeOutcome,
	type NewSetupToken,
	type RoleChange,
	type Tenant,
	type User,
	type UserPage,
} from "../../domain/auth/types";
import type { TenantId } from "../../domain/shared/identity";
import { InMemoryAuditStore } from "../audit/inMemoryAuditStore";

type StoredSetupToken = NewSetupToken & { tenantId: TenantId; userId: string; usedAt: Date | null };

const byCreatedThenId = (a: User, b: User) =>
	a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Methods do not await between a check and its write, so each one is atomic like its SQL twin.
export class InMemoryAccountRepository implements AccountRepository, CredentialStore {
	private readonly tenants = new Map<TenantId, Tenant>();
	private readonly users = new Map<string, User>();
	private readonly setupTokens = new Map<string, StoredSetupToken>();

	constructor(readonly audit: InMemoryAuditStore = new InMemoryAuditStore()) {}

	private emailTaken(email: string) {
		return [...this.users.values()].some((user) => user.email === email);
	}

	async createTenantWithAdmin(
		tenant: Tenant,
		admin: Omit<User, "tenantId">,
		audit: AuditEntry,
	): Promise<boolean> {
		if (this.emailTaken(admin.email)) return false;
		this.audit.checkSync([audit]);
		this.tenants.set(tenant.id, tenant);
		this.users.set(admin.id, { ...admin, tenantId: tenant.id });
		this.audit.appendSync([audit]);
		return true;
	}

	async findUserByEmail(email: string): Promise<User | null> {
		return [...this.users.values()].find((user) => user.email === email) ?? null;
	}

	async redeemSetupToken(
		tokenHash: string,
		now: Date,
		passwordHash: string,
		audit: (user: User) => AuditEntry,
	): Promise<User | null> {
		const token = this.setupTokens.get(tokenHash);
		if (!token || token.usedAt !== null || token.expiresAt <= now) return null;
		const user = this.users.get(token.userId);
		if (user?.tenantId !== token.tenantId) return null;

		const updated = { ...user, passwordHash };
		const entry = audit(updated);
		this.audit.checkSync([entry]);
		this.setupTokens.set(tokenHash, { ...token, usedAt: now });
		this.users.set(user.id, updated);
		this.audit.appendSync([entry]);
		return updated;
	}

	async findUser(tenantId: TenantId, userId: string): Promise<User | null> {
		const user = this.users.get(userId);
		return user?.tenantId === tenantId ? user : null;
	}

	async listUsers(tenantId: TenantId, { limit, offset }: PageQuery): Promise<UserPage> {
		const owned = [...this.users.values()]
			.filter((user) => user.tenantId === tenantId)
			.sort(byCreatedThenId);
		return { items: owned.slice(offset, offset + limit), total: owned.length };
	}

	async addUser(
		tenantId: TenantId,
		user: Omit<User, "tenantId">,
		setupToken: NewSetupToken,
		audit: AuditEntry,
	): Promise<boolean> {
		if (this.emailTaken(user.email)) return false;
		this.audit.checkSync([audit]);
		this.users.set(user.id, { ...user, tenantId });
		this.setupTokens.set(setupToken.tokenHash, {
			...setupToken,
			tenantId,
			userId: user.id,
			usedAt: null,
		});
		this.audit.appendSync([audit]);
		return true;
	}

	async changeRoles(
		tenantId: TenantId,
		changes: RoleChange[],
		audit: (before: User, after: User) => AuditEntry,
	): Promise<MemberChangeOutcome> {
		const found = this.membersOf(
			tenantId,
			changes.map((change) => change.userId),
		);
		if (!found.ok)
			return { applied: false, rejection: { reason: "not_found", indexes: found.missing } };

		const after = changes.map((change, index) => ({
			...(found.users[index] as User),
			role: change.role,
		}));
		if (
			!keepsActiveAdmin(this.activeAdmins(tenantId), new Map(after.map((user) => [user.id, user])))
		) {
			return { applied: false, rejection: { reason: "last_admin" } };
		}
		const entries = found.users.flatMap((before, index) =>
			before.role === after[index]?.role ? [] : [audit(before, after[index] as User)],
		);
		this.audit.checkSync(entries);
		for (const user of after) this.users.set(user.id, user);
		this.audit.appendSync(entries);
		return { applied: true, users: after };
	}

	async removeUsers(
		tenantId: TenantId,
		userIds: string[],
		audit: (removed: User) => AuditEntry,
	): Promise<MemberChangeOutcome> {
		const found = this.membersOf(tenantId, userIds);
		if (!found.ok)
			return { applied: false, rejection: { reason: "not_found", indexes: found.missing } };
		if (!keepsActiveAdmin(this.activeAdmins(tenantId), new Map(userIds.map((id) => [id, null])))) {
			return { applied: false, rejection: { reason: "last_admin" } };
		}
		const entries = found.users.map(audit);
		this.audit.checkSync(entries);
		const removed = new Set(userIds);
		for (const id of removed) this.users.delete(id);
		// The twin of ON DELETE CASCADE from password_setup_tokens to users.
		for (const [hash, token] of this.setupTokens) {
			if (token.tenantId === tenantId && removed.has(token.userId)) this.setupTokens.delete(hash);
		}
		this.audit.appendSync(entries);
		return { applied: true, users: found.users };
	}

	private activeAdmins(tenantId: TenantId) {
		return [...this.users.values()].filter(
			(user) => user.tenantId === tenantId && isActiveAdmin(user),
		);
	}

	// The tenant's users with these ids, in order, or the indexes of the ids it does not have.
	private membersOf(tenantId: TenantId, userIds: string[]) {
		const users = userIds.map((id) => this.users.get(id));
		const missing = users.flatMap((user, index) => (user?.tenantId === tenantId ? [] : [index]));
		return missing.length > 0
			? ({ ok: false, missing } as const)
			: ({ ok: true, users: users as User[] } as const);
	}
}
