import type { MemberInviteResponse, MemberResponse } from "../contract/members";
import type { MemberInvite, User } from "../domain/auth/types";

// The allowlist of what leaves the API. passwordHash and tenantId never do.
export const toMemberResponse = (user: User): MemberResponse => ({
	id: user.id,
	email: user.email,
	role: user.role,
	status: user.passwordHash === null ? "pending" : "active",
	createdAt: user.createdAt.toISOString(),
});

export const toMemberInviteResponse = (invite: MemberInvite): MemberInviteResponse => ({
	...toMemberResponse(invite.user),
	setupToken: invite.setupToken,
	setupTokenExpiresAt: invite.setupTokenExpiresAt.toISOString(),
});
