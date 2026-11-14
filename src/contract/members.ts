import { z } from "zod";
import { EmailSchema } from "./auth";

export const MEMBER_ROLES = ["viewer", "responder", "admin"] as const;
export const MEMBER_STATUSES = ["pending", "active"] as const;

export const AddMemberRequestSchema = z
	.strictObject({
		email: EmailSchema,
		role: z.enum(MEMBER_ROLES),
	})
	.openapi("AddMemberRequest");

export type AddMemberRequest = z.infer<typeof AddMemberRequestSchema>;

const memberFields = {
	id: z.uuid(),
	email: z.string(),
	role: z.enum(MEMBER_ROLES),
	status: z.enum(MEMBER_STATUSES),
	createdAt: z.iso.datetime(),
};

// Strict so a leaked internal field, such as passwordHash, fails the contract test.
export const MemberSchema = z.strictObject(memberFields).openapi("Member");

export type MemberResponse = z.infer<typeof MemberSchema>;

export const MemberInviteSchema = z
	.strictObject({
		...memberFields,
		setupToken: z.string(),
		setupTokenExpiresAt: z.iso.datetime(),
	})
	.openapi("MemberInvite", { description: "The setup token is shown only in this response" });

export type MemberInviteResponse = z.infer<typeof MemberInviteSchema>;

export const MemberListSchema = z
	.strictObject({
		items: z.array(MemberSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("MemberList");
