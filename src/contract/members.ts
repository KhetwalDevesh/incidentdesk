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

export const MemberIdSchema = z.uuid();

// Spec: docs/features/member-management.md
export const MAX_MEMBER_BATCH = 50;

export const UpdateMemberRequestSchema = z
	.strictObject({ role: z.enum(MEMBER_ROLES) })
	.openapi("UpdateMemberRequest");

export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequestSchema>;

// Adds an issue at each repeat of an id, so a client can find every one.
const uniqueIds =
	<T>(idOf: (item: T) => string, path: (index: number) => (string | number)[]) =>
	(items: T[], ctx: z.RefinementCtx) => {
		const seen = new Set<string>();
		items.forEach((item, index) => {
			const id = idOf(item);
			if (seen.has(id)) ctx.addIssue({ code: "custom", path: path(index), message: "Repeated id" });
			seen.add(id);
		});
	};

export const BulkUpdateMembersRequestSchema = z
	.strictObject({
		changes: z
			.array(z.strictObject({ id: MemberIdSchema, role: z.enum(MEMBER_ROLES) }))
			.min(1)
			.max(MAX_MEMBER_BATCH)
			.superRefine(
				uniqueIds(
					(change) => change.id,
					(index) => [index, "id"],
				),
			),
	})
	.openapi("BulkUpdateMembersRequest", {
		description: "All or nothing: if any change fails, none is applied",
	});

export type BulkUpdateMembersRequest = z.infer<typeof BulkUpdateMembersRequestSchema>;

export const BulkRemoveMembersRequestSchema = z
	.strictObject({
		ids: z
			.array(MemberIdSchema)
			.min(1)
			.max(MAX_MEMBER_BATCH)
			.superRefine(
				uniqueIds(
					(id) => id,
					(index) => [index],
				),
			),
	})
	.openapi("BulkRemoveMembersRequest", {
		description: "All or nothing: if any removal fails, none is applied",
	});

export type BulkRemoveMembersRequest = z.infer<typeof BulkRemoveMembersRequestSchema>;

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

export const MemberBatchSchema = z
	.strictObject({ items: z.array(MemberSchema) })
	.openapi("MemberBatch", { description: "The members after the change, in request order" });

export type MemberBatchResponse = z.infer<typeof MemberBatchSchema>;
