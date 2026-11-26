import { Hono } from "hono";
import {
	AlertSourceIdSchema,
	CreateAlertSourceRequestSchema,
	UpdateAlertSourceRequestSchema,
} from "../contract/alerts";
import { PageQuerySchema } from "../contract/common";
import type { AlertSourceService } from "../domain/alerts/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toAlertSourceResponse, toCreatedAlertSourceResponse } from "../mappers/alerts";

export const alertSourceRoutes = (service: AlertSourceService) =>
	new Hono<AppEnv>()
		.get("/", async (c) => {
			const parsed = PageQuerySchema.safeParse(c.req.query());
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.list(c.get("principal"), parsed.data);
			return respond(c, result, ({ items, total }) =>
				c.json({ items: items.map(toAlertSourceResponse), total, ...parsed.data }),
			);
		})
		.post("/", async (c) => {
			const parsed = CreateAlertSourceRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.create(c.get("principal"), parsed.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (created) => c.json(toCreatedAlertSourceResponse(created), 201));
		})
		// Spec: docs/features/on-call-schedules.md.
		.patch("/:id", async (c) => {
			const id = AlertSourceIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const parsed = UpdateAlertSourceRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.update(c.get("principal"), id.data, parsed.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (source) => c.json(toAlertSourceResponse(source)));
		});
