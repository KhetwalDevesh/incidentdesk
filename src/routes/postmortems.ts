import { Hono } from "hono";
import { PageQuerySchema } from "../contract/common";
import { IncidentIdSchema } from "../contract/incidents";
import { SavePostmortemRequestSchema } from "../contract/postmortems";
import type { PostmortemService } from "../domain/postmortems/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toPostmortemDraftResponse, toPostmortemResponse } from "../mappers/postmortems";

// Spec: docs/features/ai-postmortems.md. Mounted under /v1/incidents.
export const postmortemRoutes = (service: PostmortemService) =>
	new Hono<AppEnv>()
		.post("/:id/postmortem-drafts", async (c) => {
			const id = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));

			const result = await service.requestDraft(c.get("principal"), id.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (draft) => c.json(toPostmortemDraftResponse(draft), 202));
		})
		.get("/:id/postmortem-drafts", async (c) => {
			const id = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const page = PageQuerySchema.safeParse(c.req.query());
			if (!page.success) return problemResponse(c, validationError(page.error));

			const result = await service.listDrafts(c.get("principal"), id.data, page.data);
			return respond(c, result, ({ items, total }) =>
				c.json({ items: items.map(toPostmortemDraftResponse), total, ...page.data }),
			);
		})
		.get("/:id/postmortem", async (c) => {
			const id = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));

			const result = await service.get(c.get("principal"), id.data);
			return respond(c, result, (postmortem) => c.json(toPostmortemResponse(postmortem)));
		})
		.put("/:id/postmortem", async (c) => {
			const id = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const parsed = SavePostmortemRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.save(c.get("principal"), id.data, parsed.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (postmortem) => c.json(toPostmortemResponse(postmortem)));
		})
		.post("/:id/postmortem/publish", async (c) => {
			const id = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));

			const result = await service.publish(c.get("principal"), id.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (postmortem) => c.json(toPostmortemResponse(postmortem)));
		});
