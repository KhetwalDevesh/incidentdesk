import { Hono } from "hono";
import { AuditEventQuerySchema } from "../contract/audit";
import { PageQuerySchema } from "../contract/common";
import { IncidentIdSchema } from "../contract/incidents";
import type { AuditService } from "../domain/audit/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toAuditEventResponse } from "../mappers/audit";

// Mounted at /v1. Spec: docs/features/audit-log.md.
export const auditRoutes = (service: AuditService) =>
	new Hono<AppEnv>()
		.get("/audit-events", async (c) => {
			const parsed = AuditEventQuerySchema.safeParse(c.req.query());
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.list(c.get("principal"), parsed.data);
			return respond(c, result, ({ items, total }) =>
				c.json({
					items: items.map(toAuditEventResponse),
					total,
					limit: parsed.data.limit,
					offset: parsed.data.offset,
				}),
			);
		})
		.get("/incidents/:id/events", async (c) => {
			const id = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const page = PageQuerySchema.safeParse(c.req.query());
			if (!page.success) return problemResponse(c, validationError(page.error));

			const result = await service.incidentTimeline(c.get("principal"), id.data, page.data);
			return respond(c, result, ({ items, total }) =>
				c.json({ items: items.map(toAuditEventResponse), total, ...page.data }),
			);
		});
