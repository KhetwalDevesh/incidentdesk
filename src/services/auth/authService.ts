import { randomBytes, randomUUID } from "node:crypto";
import { type AuditRecorder, auditEntry, auditOrigin } from "../../domain/audit/types";
import {
	type AccountRepository,
	type AuthService,
	type CredentialStore,
	hashSetupToken,
	type PasswordHasher,
	type TokenService,
} from "../../domain/auth/types";
import type { TenantId } from "../../domain/shared/identity";
import { fail, ok } from "../../domain/shared/result";

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
};

export const createAuthService = ({
	credentials,
	accounts,
	hasher,
	tokens,
	audit,
	now = () => new Date(),
	onAuditError = () => undefined,
}: AuthServiceDeps): AuthService => {
	// Verified against when there is no real hash, so an unknown email costs the same time as a wrong password.
	let dummyHash: Promise<string> | undefined;
	const getDummyHash = () => {
		dummyHash ??= hasher.hash(randomBytes(16).toString("hex"));
		return dummyHash;
	};

	return {
		async signup({ tenantName, email, password }, context) {
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
				return fail("UNAUTHENTICATED", "Email or password is incorrect");
			}
			return ok(await tokens.issue({ tenantId: user.tenantId, userId: user.id }));
		},

		async setupPassword({ token, password }, context) {
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
			if (!user) return fail("UNAUTHENTICATED", "Setup token is invalid, used or expired");
			return ok(await tokens.issue({ tenantId: user.tenantId, userId: user.id }));
		},

		async authenticate(token) {
			const claims = await tokens.verify(token);
			if (!claims) return null;
			// Loaded per request, so a removed user or a changed role applies immediately.
			const user = await accounts.findUser(claims.tenantId, claims.userId);
			if (!user?.passwordHash) return null;
			return { tenantId: user.tenantId, userId: user.id, role: user.role };
		},
	};
};
