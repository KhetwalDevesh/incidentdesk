import { Hono } from "hono";
import { DashboardQuerySchema } from "../contract/dashboard";
import type { DashboardService } from "../domain/dashboard/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toDashboardResponse } from "../mappers/dashboard";

// Spec: docs/features/dashboard-stats.md
export const dashboardRoutes = (service: DashboardService) =>
	new Hono<AppEnv>().get("/", async (c) => {
		const parsed = DashboardQuerySchema.safeParse(c.req.query());
		if (!parsed.success) return problemResponse(c, validationError(parsed.error));

		const { from, to } = parsed.data;
		const window = from && to ? { from: new Date(from), to: new Date(to) } : null;
		const result = await service.get(c.get("principal"), window);
		return respond(c, result, (dashboard) => c.json(toDashboardResponse(dashboard)));
	});
