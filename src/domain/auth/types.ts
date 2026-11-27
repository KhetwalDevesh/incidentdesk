import { createHash } from "node:crypto";
import type { LoginRequest, SetupPasswordRequest, SignupRequest } from "../../contract/auth";
import type { PageQuery } from "../../contract/common";
import type { AddMemberRequest, BulkUpdateMembersRequest } from "../../contract/members";
import type { AuditEntry } from "../audit/types";
import type { Principal, Role, TenantId } from "../shared/identity";
import type { RequestContext } from "../shared/request";
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

// An active admin can sign in. A pending one cannot until they set a password.
export const isActiveAdmin = (user: User) => user.role === "admin" && user.passwordHash !== null;

export const memberStatus = (user: User) => (user.passwordHash === null ? "pending" : "active");

export type RoleChange = { userId: string; role: Role };

// Whether a batch keeps at least one active admin. `after` maps each user in the batch to
// what it becomes, or null when removed. `activeAdmins` are the tenant's active admins now.
export const keepsActiveAdmin = (activeAdmins: User[], after: Map<string, User | null>) =>
	activeAdmins.some((admin) => !after.has(admin.id)) ||
	[...after.values()].some((user) => user !== null && isActiveAdmin(user));

// Why a batch of member changes was refused. Nothing was changed.
export type MemberChangeRejection =
	// Indexes into the request of every id that is not a member of the tenant.
	| { reason: "not_found"; indexes: number[] }
	// Applying the batch would leave the tenant with no active admin.
	| { reason: "last_admin" };

export type MemberChangeOutcome =
	| { applied: true; users: User[] }
	| { applied: false; rejection: MemberChangeRejection };

// Setup tokens are stored only as this hash, so a database leak does not hand out logins.
export const hashSetupToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Tenant-scoped. Every method takes tenantId first, like every repository.
export interface AccountRepository {
	findUser(tenantId: TenantId, userId: string): Promise<User | null>;
	// The tenant's members among these ids, in any order. Bounded by the ids given.
	findUsers(tenantId: TenantId, userIds: string[]): Promise<User[]>;
	listUsers(tenantId: TenantId, page: PageQuery): Promise<UserPage>;
	// Returns false when the email is already registered, in any tenant.
	addUser(
		tenantId: TenantId,
		user: Omit<User, "tenantId">,
		setupToken: NewSetupToken,
		// Written only when the user is added.
		audit: AuditEntry,
	): Promise<boolean>;
	// All or nothing, in one transaction that locks the tenant's active admins first, so
	// concurrent batches cannot leave the tenant without one. `users` are the members after
	// the change, in request order. `audit` builds an entry for each member whose role
	// actually changed; a member given their current role writes none.
	changeRoles(
		tenantId: TenantId,
		changes: RoleChange[],
		audit: (before: User, after: User) => AuditEntry,
	): Promise<MemberChangeOutcome>;
	// All or nothing, under the same lock. Deletes the users and their setup tokens, removes
	// them from on-call rotations and overrides, and unassigns their incidents.
	// `users` are the members as they were, in request order.
	removeUsers(
		tenantId: TenantId,
		userIds: string[],
		audit: (removed: User) => AuditEntry,
	): Promise<MemberChangeOutcome>;
}

// The only operations that run before the tenant is known. Audit every caller.
export interface CredentialStore {
	// Returns false when the email is already registered.
	createTenantWithAdmin(
		tenant: Tenant,
		admin: Omit<User, "tenantId">,
		audit: AuditEntry,
	): Promise<boolean>;
	findUserByEmail(email: string): Promise<User | null>;
	// Atomically marks an unused, unexpired token as used and sets the password.
	// Returns null when no token matched, so two racing redemptions cannot both win.
	// `audit` builds the entry from the redeemed user, whose tenant is unknown until then.
	redeemSetupToken(
		tokenHash: string,
		now: Date,
		passwordHash: string,
		audit: (user: User) => AuditEntry,
	): Promise<User | null>;
}

export interface PasswordHasher {
	hash(password: string): Promise<string>;
	verify(passwordHash: string, password: string): Promise<boolean>;
}

export type AccessToken = { accessToken: string; expiresIn: number };
export type TokenClaims = { tenantId: TenantId; userId: string };
// What a verified token says, including when it stops being valid.
export type VerifiedToken = TokenClaims & { expiresAt: Date };

export interface TokenService {
	issue(claims: TokenClaims): Promise<AccessToken>;
	// Null for any token that is malformed, tampered, expired or signed another way.
	verify(token: string): Promise<VerifiedToken | null>;
}

export interface AuthService {
	signup(input: SignupRequest, context?: RequestContext): Promise<Result<AccessToken>>;
	login(input: LoginRequest, context?: RequestContext): Promise<Result<AccessToken>>;
	setupPassword(
		input: SetupPasswordRequest,
		context?: RequestContext,
	): Promise<Result<AccessToken>>;
	authenticate(token: string): Promise<Principal | null>;
}

export type MemberInvite = { user: User; setupToken: string; setupTokenExpiresAt: Date };

export interface MemberService {
	list(principal: Principal, page: PageQuery): Promise<Result<UserPage>>;
	add(
		principal: Principal,
		input: AddMemberRequest,
		context?: RequestContext,
	): Promise<Result<MemberInvite>>;
	changeRole(
		principal: Principal,
		userId: string,
		role: Role,
		context?: RequestContext,
	): Promise<Result<User>>;
	changeRoles(
		principal: Principal,
		changes: BulkUpdateMembersRequest["changes"],
		context?: RequestContext,
	): Promise<Result<User[]>>;
	remove(principal: Principal, userId: string, context?: RequestContext): Promise<Result<void>>;
	removeMany(
		principal: Principal,
		userIds: string[],
		context?: RequestContext,
	): Promise<Result<void>>;
}

// ---- Throttling public auth routes. Spec: docs/features/login-rate-limiting.md

export type ThrottleRule = {
	// Counted events allowed in one window. Reaching it locks the key.
	limit: number;
	windowMs: number;
	lockMs: number;
};

const MINUTE_MS = 60_000;

export const THROTTLE_RULES = {
	loginEmail: { limit: 5, windowMs: 15 * MINUTE_MS, lockMs: 15 * MINUTE_MS },
	loginIp: { limit: 30, windowMs: 15 * MINUTE_MS, lockMs: 15 * MINUTE_MS },
	setupIp: { limit: 10, windowMs: 15 * MINUTE_MS, lockMs: 15 * MINUTE_MS },
	signupIp: { limit: 10, windowMs: 60 * MINUTE_MS, lockMs: 60 * MINUTE_MS },
} as const satisfies Record<string, ThrottleRule>;

// Stale keys are purged this long after their last event and lock.
export const THROTTLE_RETENTION_MS = 24 * 60 * MINUTE_MS;

// Keys never hold an email: only its SHA-256, so the table holds no address.
export const throttleKeys = {
	loginEmail: (email: string) =>
		`login:email:${createHash("sha256").update(email.toLowerCase()).digest("hex")}`,
	loginIp: (ip: string | null) => `login:ip:${ip ?? "unknown"}`,
	setupIp: (ip: string | null) => `setup:ip:${ip ?? "unknown"}`,
	signupIp: (ip: string | null) => `signup:ip:${ip ?? "unknown"}`,
};

// What recording one event did. `lockedNow` is true only for the event that started a lock.
export type ThrottleOutcome = { count: number; lockedUntil: Date | null; lockedNow: boolean };

// Runs before any tenant is known: keys are global. Audit every caller.
export interface LoginThrottle {
	// The latest lock end among these keys still in the future, or null when none is locked.
	lockedUntil(keys: string[], now: Date): Promise<Date | null>;
	// Counts one event, in one atomic step: starts a new window when the old one has passed,
	// and locks the key when the count reaches the rule's limit.
	record(key: string, rule: ThrottleRule, now: Date): Promise<ThrottleOutcome>;
	// Forgets the key's count, as after a successful sign-in.
	clear(key: string): Promise<void>;
	// Deletes up to `limit` keys whose last event and lock both ended before `cutoff`.
	purgeOlderThan(cutoff: Date, limit: number): Promise<number>;
}
