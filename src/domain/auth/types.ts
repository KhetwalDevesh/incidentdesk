import { createHash } from "node:crypto";
import type { LoginRequest, SetupPasswordRequest, SignupRequest } from "../../contract/auth";
import type { PageQuery } from "../../contract/common";
import type { AddMemberRequest } from "../../contract/members";
import type { Principal, Role, TenantId } from "../shared/identity";
import type { Result } from "../shared/result";

export type Tenant = { id: TenantId; name: string; createdAt: Date };

export type User = {
	id: string;
	tenantId: TenantId;
	email: string;
	role: Role;
	// Null while the member has not set a password yet.
	passwordHash: string | null;
	createdAt: Date;
};

export type UserPage = { items: User[]; total: number };

export type NewSetupToken = { tokenHash: string; expiresAt: Date };

// Setup tokens are stored only as this hash, so a database leak does not hand out logins.
export const hashSetupToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Tenant-scoped. Every method takes tenantId first, like every repository.
export interface AccountRepository {
	findUser(tenantId: TenantId, userId: string): Promise<User | null>;
	listUsers(tenantId: TenantId, page: PageQuery): Promise<UserPage>;
	// Returns false when the email is already registered, in any tenant.
	addUser(
		tenantId: TenantId,
		user: Omit<User, "tenantId">,
		setupToken: NewSetupToken,
	): Promise<boolean>;
}

// The only operations that run before the tenant is known. Audit every caller.
export interface CredentialStore {
	// Returns false when the email is already registered.
	createTenantWithAdmin(tenant: Tenant, admin: Omit<User, "tenantId">): Promise<boolean>;
	findUserByEmail(email: string): Promise<User | null>;
	// Atomically marks an unused, unexpired token as used and sets the password.
	// Returns null when no token matched, so two racing redemptions cannot both win.
	redeemSetupToken(tokenHash: string, now: Date, passwordHash: string): Promise<User | null>;
}

export interface PasswordHasher {
	hash(password: string): Promise<string>;
	verify(passwordHash: string, password: string): Promise<boolean>;
}

export type AccessToken = { accessToken: string; expiresIn: number };
export type TokenClaims = { tenantId: TenantId; userId: string };

export interface TokenService {
	issue(claims: TokenClaims): Promise<AccessToken>;
	// Null for any token that is malformed, tampered, expired or signed another way.
	verify(token: string): Promise<TokenClaims | null>;
}

export interface AuthService {
	signup(input: SignupRequest): Promise<Result<AccessToken>>;
	login(input: LoginRequest): Promise<Result<AccessToken>>;
	setupPassword(input: SetupPasswordRequest): Promise<Result<AccessToken>>;
	authenticate(token: string): Promise<Principal | null>;
}

export type MemberInvite = { user: User; setupToken: string; setupTokenExpiresAt: Date };

export interface MemberService {
	list(principal: Principal, page: PageQuery): Promise<Result<UserPage>>;
	add(principal: Principal, input: AddMemberRequest): Promise<Result<MemberInvite>>;
}
