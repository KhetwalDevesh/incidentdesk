import { randomBytes, randomUUID } from "node:crypto";
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
	now?: () => Date;
};

export const createAuthService = ({
	credentials,
	accounts,
	hasher,
	tokens,
	now = () => new Date(),
}: AuthServiceDeps): AuthService => {
	// Verified against when there is no real hash, so an unknown email costs the same time as a wrong password.
	let dummyHash: Promise<string> | undefined;
	const getDummyHash = () => {
		dummyHash ??= hasher.hash(randomBytes(16).toString("hex"));
		return dummyHash;
	};

	return {
		async signup({ tenantName, email, password }) {
			const createdAt = now();
			const tenant = { id: randomUUID() as TenantId, name: tenantName, createdAt };
			const admin = {
				id: randomUUID(),
				email,
				role: "admin" as const,
				passwordHash: await hasher.hash(password),
				createdAt,
			};
			if (!(await credentials.createTenantWithAdmin(tenant, admin))) {
				return fail("CONFLICT", "An account with this email already exists");
			}
			return ok(await tokens.issue({ tenantId: tenant.id, userId: admin.id }));
		},

		async login({ email, password }) {
			const user = await credentials.findUserByEmail(email);
			const valid = await hasher.verify(user?.passwordHash ?? (await getDummyHash()), password);
			// One message for unknown email, pending member and wrong password.
			if (!user?.passwordHash || !valid) {
				return fail("UNAUTHENTICATED", "Email or password is incorrect");
			}
			return ok(await tokens.issue({ tenantId: user.tenantId, userId: user.id }));
		},

		async setupPassword({ token, password }) {
			const passwordHash = await hasher.hash(password);
			const user = await credentials.redeemSetupToken(hashSetupToken(token), now(), passwordHash);
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
