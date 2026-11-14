import { Hono } from "hono";
import { PageQuerySchema } from "../contract/common";
import { AddMemberRequestSchema } from "../contract/members";
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

			const result = await service.add(c.get("principal"), parsed.data);
			return respond(c, result, (invite) => c.json(toMemberInviteResponse(invite), 201));
		});
