import { randomBytes, randomUUID } from "node:crypto";
import {
	type AccountRepository,
	hashSetupToken,
	type MemberService,
} from "../../domain/auth/types";
import { isAdmin } from "../../domain/shared/identity";
import { fail, ok } from "../../domain/shared/result";

const SETUP_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

export const createMemberService = (
	accounts: AccountRepository,
	now: () => Date = () => new Date(),
): MemberService => ({
	async list(principal, page) {
		if (!isAdmin(principal)) return fail("FORBIDDEN", "Only admins can list members");
		return ok(await accounts.listUsers(principal.tenantId, page));
	},

	async add(principal, { email, role }) {
		if (!isAdmin(principal)) return fail("FORBIDDEN", "Only admins can add members");

		const createdAt = now();
		const user = { id: randomUUID(), email, role, passwordHash: null, createdAt };
		const setupToken = randomBytes(32).toString("base64url");
		const setupTokenExpiresAt = new Date(createdAt.getTime() + SETUP_TOKEN_TTL_MS);

		const added = await accounts.addUser(principal.tenantId, user, {
			tokenHash: hashSetupToken(setupToken),
			expiresAt: setupTokenExpiresAt,
		});
		if (!added) return fail("CONFLICT", "An account with this email already exists");

		return ok({ user: { ...user, tenantId: principal.tenantId }, setupToken, setupTokenExpiresAt });
	},
});
