import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { IncidentService } from "../domain/incidents/types";
import { healthRoutes } from "../routes/health";
import { incidentRoutes } from "../routes/incidents";
import { type Authenticator, requireAuth } from "./auth";
import { problemResponse } from "./problem";
import type { AppEnv } from "./types";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export type AppDeps = {
	authenticate: Authenticator;
	incidentService: IncidentService;
};

export const createApp = ({ authenticate, incidentService }: AppDeps) => {
	const app = new Hono<AppEnv>();

	app.use("*", async (c, next) => {
		const inbound = c.req.header("X-Request-ID");
		const requestId = inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
		c.set("requestId", requestId);
		c.header("X-Request-ID", requestId);
		await next();
	});

	app.notFound((c) => problemResponse(c, { code: "NOT_FOUND", detail: "Route not found" }));
	// The detail is fixed so an unexpected error never reaches a client.
	app.onError((_error, c) =>
		problemResponse(c, { code: "INTERNAL", detail: "An unexpected error occurred" }),
	);

	app.route("/", healthRoutes());
	app.use("/v1/*", requireAuth(authenticate));
	app.route("/v1/incidents", incidentRoutes(incidentService));

	return app;
};
