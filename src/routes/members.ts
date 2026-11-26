import { Hono } from "hono";
import { PageQuerySchema } from "../contract/common";
import {
	AddMemberRequestSchema,
	BulkRemoveMembersRequestSchema,
	BulkUpdateMembersRequestSchema,
	MemberIdSchema,
	UpdateMemberRequestSchema,
} from "../contract/members";
import type { MemberService } from "../domain/auth/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toMemberInviteResponse, toMemberResponse } from "../mappers/members";

export const memberRoutes = (service: MemberService) =>
	new Hono<AppEnv>()
		.get("/", async (c) => {
			const parsed = PageQuerySchema.safeParse(c.req.query());
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.list(c.get("principal"), parsed.data);
			return respond(c, result, ({ items, total }) =>
				c.json({ items: items.map(toMemberResponse), total, ...parsed.data }),
			);
		})
		.post("/", async (c) => {
			const parsed = AddMemberRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.add(c.get("principal"), parsed.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (invite) => c.json(toMemberInviteResponse(invite), 201));
		})
		// Bulk routes. Spec: docs/features/member-management.md. All or nothing.
		.patch("/", async (c) => {
			const parsed = BulkUpdateMembersRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.changeRoles(c.get("principal"), parsed.data.changes, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (users) => c.json({ items: users.map(toMemberResponse) }));
		})
		// POST, not DELETE with a body, which many clients and proxies drop.
		.post("/remove", async (c) => {
			const parsed = BulkRemoveMembersRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.removeMany(c.get("principal"), parsed.data.ids, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, () => c.body(null, 204));
		})
		.patch("/:id", async (c) => {
			const id = MemberIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const parsed = UpdateMemberRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.changeRole(c.get("principal"), id.data, parsed.data.role, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (user) => c.json(toMemberResponse(user)));
		})
		.delete("/:id", async (c) => {
			const id = MemberIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));

			const result = await service.remove(c.get("principal"), id.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, () => c.body(null, 204));
		});
