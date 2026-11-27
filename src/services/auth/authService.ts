import { randomBytes, randomUUID } from "node:crypto";
import { type AuditRecorder, auditEntry, auditOrigin } from "../../domain/audit/types";
import {
	type AccountRepository,
	type AuthService,
	type CredentialStore,
	hashSetupToken,
	type LoginThrottle,
	type PasswordHasher,
	THROTTLE_RULES,
	type TokenService,
	throttleKeys,
} from "../../domain/auth/types";
import type { TenantId } from "../../domain/shared/identity";
import { fail, ok, type Result } from "../../domain/shared/result";

// A locked caller's answer: the same for every key, so it reveals neither which limit was hit
// nor whether an account exists. Spec: docs/features/login-rate-limiting.md.
const tooMany = (lockedUntil: Date, now: Date): Result<never> => ({
	ok: false,
	error: {
		code: "TOO_MANY_REQUESTS",
		detail: "Too many attempts. Try again later.",
		retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)),
	},
});

export type AuthServiceDeps = {
	credentials: CredentialStore;
	accounts: AccountRepository;
	hasher: PasswordHasher;
	tokens: TokenService;
	// Records sign-ins. Every other auth entry is written with its change.
	audit: AuditRecorder;
	now?: () => Date;
	// Gets the entry id, never the entry, so a failed write cannot leak details into logs.
	onAuditError?: (entryId: string, error: unknown) => void;
	// Counts failed and repeated attempts on these public routes.
	throttle: LoginThrottle;
	// Told when an IP lock starts: the kind of key and when it ends, never the address.
	onIpLocked?: (route: "login" | "setup" | "signup", until: Date) => void;
};

export const createAuthService = ({
	credentials,
	accounts,
	hasher,
	tokens,
	audit,
	now = () => new Date(),
	onAuditError = () => undefined,
	throttle,
	onIpLocked = () => undefined,
}: AuthServiceDeps): AuthService => {
	// Verified against when there is no real hash, so an unknown email costs the same time as a wrong password.
	let dummyHash: Promise<string> | undefined;
	const getDummyHash = () => {
		dummyHash ??= hasher.hash(randomBytes(16).toString("hex"));
		return dummyHash;
	};

	return {
		async signup({ tenantName, email, password }, context) {
			// Every attempt counts, successful or not: the risk here is account spam.
			const key = throttleKeys.signupIp(context?.clientIp ?? null);
			const locked = await throttle.lockedUntil([key], now());
			if (locked) return tooMany(locked, now());
			const counted = await throttle.record(key, THROTTLE_RULES.signupIp, now());
			if (counted.lockedNow && counted.lockedUntil) onIpLocked("signup", counted.lockedUntil);

			const createdAt = now();
			const tenant = { id: randomUUID() as TenantId, name: tenantName, createdAt };
			const admin = {
				id: randomUUID(),
				email,
				role: "admin" as const,
				passwordHash: await hasher.hash(password),
				createdAt,
			};
			const created = auditEntry(
				auditOrigin(createdAt, context),
				tenant.id,
				"tenant.created",
				{ type: "user", id: admin.id },
				{ type: "tenant", id: tenant.id },
				{ name: tenantName },
			);
			if (!(await credentials.createTenantWithAdmin(tenant, admin, created))) {
				return fail("CONFLICT", "An account with this email already exists");
			}
			return ok(await tokens.issue({ tenantId: tenant.id, userId: admin.id }));
		},

		async login({ email, password }, context) {
			const emailKey = throttleKeys.loginEmail(email);
			const ipKey = throttleKeys.loginIp(context?.clientIp ?? null);
			// Checked before the lookup and the hash: a locked caller costs one indexed read.
			const locked = await throttle.lockedUntil([emailKey, ipKey], now());
			if (locked) return tooMany(locked, now());

			const user = await credentials.findUserByEmail(email);
			const valid = await hasher.verify(user?.passwordHash ?? (await getDummyHash()), password);
			const succeeded = Boolean(user?.passwordHash) && valid;
			// Only a known email has a tenant to record it in. The typed email is never stored.
			// Not awaited, so recording never delays the response or reveals that the email exists.
			if (user) {
				const entry = auditEntry(
					auditOrigin(now(), context),
					user.tenantId,
					succeeded ? "user.login_succeeded" : "user.login_failed",
					succeeded ? { type: "user", id: user.id } : { type: "anonymous", id: null },
					{ type: "user", id: user.id },
					{},
				);
				void audit.record(entry).catch((error) => onAuditError(entry.id, error));
			}
			// One message for unknown email, pending member and wrong password.
			if (!user || !succeeded) {
				// Unknown emails count too, so a lock reveals nothing about which accounts exist.
				const at = now();
				const [byEmail, byIp] = await Promise.all([
					throttle.record(emailKey, THROTTLE_RULES.loginEmail, at),
					throttle.record(ipKey, THROTTLE_RULES.loginIp, at),
				]);
				if (byEmail.lockedNow && user) {
					const entry = auditEntry(
						auditOrigin(at, context),
						user.tenantId,
						"user.login_locked",
						{ type: "anonymous", id: null },
						{ type: "user", id: user.id },
						{},
					);
					void audit.record(entry).catch((error) => onAuditError(entry.id, error));
				}
				if (byIp.lockedNow && byIp.lockedUntil) onIpLocked("login", byIp.lockedUntil);
				return fail("UNAUTHENTICATED", "Email or password is incorrect");
			}
			// Clears the email's count only: one success must not reset a sprayer's IP count.
			await throttle.clear(emailKey);
			return ok(await tokens.issue({ tenantId: user.tenantId, userId: user.id }));
		},

		async setupPassword({ token, password }, context) {
			const key = throttleKeys.setupIp(context?.clientIp ?? null);
			const locked = await throttle.lockedUntil([key], now());
			if (locked) return tooMany(locked, now());

			const passwordHash = await hasher.hash(password);
			const at = now();
			const user = await credentials.redeemSetupToken(
				hashSetupToken(token),
				at,
				passwordHash,
				(redeemed) =>
					auditEntry(
						auditOrigin(at, context),
						redeemed.tenantId,
						"member.setup_completed",
						{ type: "user", id: redeemed.id },
						{ type: "user", id: redeemed.id },
						{},
					),
			);
			if (!user) {
				const counted = await throttle.record(key, THROTTLE_RULES.setupIp, now());
				if (counted.lockedNow && counted.lockedUntil) onIpLocked("setup", counted.lockedUntil);
				return fail("UNAUTHENTICATED", "Setup token is invalid, used or expired");
			}
			return ok(await tokens.issue({ tenantId: user.tenantId, userId: user.id }));
		},

		async authenticate(token) {
			const claims = await tokens.verify(token);
			if (!claims) return null;
			// Loaded per request, so a removed user or a changed role applies immediately.
			const user = await accounts.findUser(claims.tenantId, claims.userId);
			if (!user?.passwordHash) return null;
			return {
				tenantId: user.tenantId,
				userId: user.id,
				role: user.role,
				expiresAt: claims.expiresAt,
			};
		},
	};
};
