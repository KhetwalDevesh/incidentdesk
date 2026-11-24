import { Hono } from "hono";
import { AlertListQuerySchema } from "../contract/alerts";
import type { AlertService } from "../domain/alerts/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toAlertResponse } from "../mappers/alerts";

export const alertRoutes = (service: AlertService) =>
	new Hono<AppEnv>().get("/", async (c) => {
		const parsed = AlertListQuerySchema.safeParse(c.req.query());
		if (!parsed.success) return problemResponse(c, validationError(parsed.error));

		const result = await service.list(c.get("principal"), parsed.data);
		return respond(c, result, ({ items, total }) =>
			c.json({ items: items.map(toAlertResponse), total, ...parsed.data }),
		);
	});
