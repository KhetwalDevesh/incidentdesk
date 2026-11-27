import { Hono } from "hono";
import { PageQuerySchema } from "../contract/common";
import { IncidentIdSchema } from "../contract/incidents";
import { SetSummaryRequestSchema } from "../contract/summaries";
import type { SummaryService } from "../domain/summaries/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toIncidentResponse } from "../mappers/incidents";
import { toSummaryDraftResponse } from "../mappers/summaries";

// Spec: docs/features/ai-summaries.md. Mounted under /v1/incidents.
export const summaryRoutes = (service: SummaryService) =>
	new Hono<AppEnv>()
		.post("/:id/summary-drafts", async (c) => {
			const id = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));

			const result = await service.requestDraft(c.get("principal"), id.data, {
				requestId: c.get("requestId"),
			});
			// 202: the draft is written in the background.
			return respond(c, result, (draft) => c.json(toSummaryDraftResponse(draft), 202));
		})
		.get("/:id/summary-drafts", async (c) => {
			const id = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const page = PageQuerySchema.safeParse(c.req.query());
			if (!page.success) return problemResponse(c, validationError(page.error));

			const result = await service.listDrafts(c.get("principal"), id.data, page.data);
			return respond(c, result, ({ items, total }) =>
				c.json({ items: items.map(toSummaryDraftResponse), total, ...page.data }),
			);
		})
		.put("/:id/summary", async (c) => {
			const id = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const parsed = SetSummaryRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.setSummary(c.get("principal"), id.data, parsed.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (incident) => c.json(toIncidentResponse(incident)));
		});
