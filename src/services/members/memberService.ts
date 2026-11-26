import { randomBytes, randomUUID } from "node:crypto";
import { auditEntry, auditOrigin } from "../../domain/audit/types";
import {
	type AccountRepository,
	hashSetupToken,
	type MemberChangeOutcome,
	type MemberService,
	memberStatus,
} from "../../domain/auth/types";
import { isAdmin, type Principal, type Role } from "../../domain/shared/identity";
import type { RequestContext } from "../../domain/shared/request";
import { type AppError, fail, ok, type Result } from "../../domain/shared/result";

const SETUP_TOKEN_TTL_MS = 72 * 60 * 60 * 1000;

// Turns a refused batch into the problem the API returns. `pathOf` names an item for a client:
// "changes.2.id" for a bulk request, and nothing for a single-member route.
const refused = (
	outcome: Extract<MemberChangeOutcome, { applied: false }>,
	pathOf: (index: number) => string | null,
): Result<never> => {
	if (outcome.rejection.reason === "last_admin") {
		return fail("CONFLICT", "The tenant must keep at least one active admin");
	}
	return withItems(
		{ code: "NOT_FOUND", detail: "Member not found" },
		outcome.rejection.indexes,
		pathOf,
		"Member not found",
	);
};

const withItems = (
	error: AppError,
	indexes: number[],
	pathOf: (index: number) => string | null,
	message: string,
): Result<never> => {
	const errors = indexes.flatMap((index) => {
		const path = pathOf(index);
		return path === null ? [] : [{ path, message }];
	});
	return { ok: false, error: errors.length > 0 ? { ...error, errors } : error };
};

// Spec: docs/features/member-management.md. Checked before anything is looked up, so a
// request that includes the caller is refused even if it names unknown members too.
const includesCaller = (
	principal: Principal,
	userIds: string[],
	pathOf: (index: number) => string | null,
	detail: string,
): Result<never> | null => {
	const indexes = userIds.flatMap((id, index) => (id === principal.userId ? [index] : []));
	return indexes.length === 0
		? null
		: withItems({ code: "CONFLICT", detail }, indexes, pathOf, "This is you");
};

export const createMemberService = (
	accounts: AccountRepository,
	now: () => Date = () => new Date(),
): MemberService => {
	const changeRoles = async (
		principal: Principal,
		changes: { id: string; role: Role }[],
		context: RequestContext | undefined,
		pathOf: (index: number) => string | null,
	) => {
		if (!isAdmin(principal)) return fail("FORBIDDEN", "Only admins can change roles");
		const self = includesCaller(
			principal,
			changes.map((change) => change.id),
			pathOf,
			"You cannot change your own role",
		);
		if (self) return self;

		const at = now();
		const outcome = await accounts.changeRoles(
			principal.tenantId,
			changes.map(({ id, role }) => ({ userId: id, role })),
			(before, after) =>
				auditEntry(
					auditOrigin(at, context),
					principal.tenantId,
					"member.role_changed",
					{ type: "user", id: principal.userId },
					{ type: "user", id: before.id },
					{ from: before.role, to: after.role },
				),
		);
		return outcome.applied ? ok(outcome.users) : refused(outcome, pathOf);
	};

	const remove = async (
		principal: Principal,
		userIds: string[],
		context: RequestContext | undefined,
		pathOf: (index: number) => string | null,
	): Promise<Result<void>> => {
		if (!isAdmin(principal)) return fail("FORBIDDEN", "Only admins can remove members");
		const self = includesCaller(principal, userIds, pathOf, "You cannot remove yourself");
		if (self) return self;

		const at = now();
		const outcome = await accounts.removeUsers(principal.tenantId, userIds, (removed) =>
			auditEntry(
				auditOrigin(at, context),
				principal.tenantId,
				"member.removed",
				{ type: "user", id: principal.userId },
				{ type: "user", id: removed.id },
				// The role and status only: never the email.
				{ role: removed.role, status: memberStatus(removed) },
			),
		);
		return outcome.applied ? ok(undefined) : refused(outcome, pathOf);
	};

	const single = () => null;

	return {
		// Every member may list their tenant's members. Spec: docs/features/on-call-schedules.md.
		async list(principal, page) {
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

			return ok({
				user: { ...user, tenantId: principal.tenantId },
				setupToken,
				setupTokenExpiresAt,
			});
		},

		async changeRole(principal, userId, role, context) {
			const result = await changeRoles(principal, [{ id: userId, role }], context, single);
			if (!result.ok) return result;
			const [user] = result.value;
			// One change in, one member out: a batch returns its members in request order.
			return user ? ok(user) : fail("INTERNAL", "Role change returned no member");
		},

		changeRoles: (principal, changes, context) =>
			changeRoles(principal, changes, context, (index) => `changes.${index}.id`),

		remove: (principal, userId, context) => remove(principal, [userId], context, single),

		removeMany: (principal, userIds, context) =>
			remove(principal, userIds, context, (index) => `ids.${index}`),
	};
};
