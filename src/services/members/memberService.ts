import { randomBytes, randomUUID } from "node:crypto";
import { auditEntry, auditOrigin } from "../../domain/audit/types";
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

	async add(principal, { email, role }, context) {
		if (!isAdmin(principal)) return fail("FORBIDDEN", "Only admins can add members");

		const createdAt = now();
		const user = { id: randomUUID(), email, role, passwordHash: null, createdAt };
		const setupToken = randomBytes(32).toString("base64url");
		const setupTokenExpiresAt = new Date(createdAt.getTime() + SETUP_TOKEN_TTL_MS);

		const added = await accounts.addUser(
			principal.tenantId,
			user,
			{ tokenHash: hashSetupToken(setupToken), expiresAt: setupTokenExpiresAt },
			auditEntry(
				auditOrigin(createdAt, context),
				principal.tenantId,
				"member.invited",
				{ type: "user", id: principal.userId },
				{ type: "user", id: user.id },
				{ role },
			),
		);
		if (!added) return fail("CONFLICT", "An account with this email already exists");

		return ok({ user: { ...user, tenantId: principal.tenantId }, setupToken, setupTokenExpiresAt });
	},
});
