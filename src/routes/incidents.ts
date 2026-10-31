import { Hono } from "hono";
import { PageQuerySchema } from "../contract/common";
import { CreateIncidentRequestSchema, IncidentIdSchema } from "../contract/incidents";
import type { IncidentService } from "../domain/incidents/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toIncidentResponse } from "../mappers/incidents";

export const incidentRoutes = (service: IncidentService) =>
	new Hono<AppEnv>()
		.post("/", async (c) => {
			const parsed = CreateIncidentRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.create(c.get("principal"), parsed.data);
			return respond(c, result, (incident) => {
				c.header("Location", `/v1/incidents/${incident.id}`);
				return c.json(toIncidentResponse(incident), 201);
			});
		})
		.get("/", async (c) => {
			const parsed = PageQuerySchema.safeParse(c.req.query());
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.list(c.get("principal"), parsed.data);
			return respond(c, result, ({ items, total }) =>
				c.json({ items: items.map(toIncidentResponse), total, ...parsed.data }),
			);
		})
		.get("/:id", async (c) => {
			const parsed = IncidentIdSchema.safeParse(c.req.param("id"));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.get(c.get("principal"), parsed.data);
			return respond(c, result, (incident) => c.json(toIncidentResponse(incident)));
		});
