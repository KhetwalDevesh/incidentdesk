import type { PageQuery } from "../../contract/common";
import type { AuditEntry } from "../../domain/audit/types";
import type {
	AccountRepository,
	CredentialStore,
	NewSetupToken,
	Tenant,
	User,
	UserPage,
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
}
