import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AuthService, MemberService } from "../domain/auth/types";
import type { IncidentService } from "../domain/incidents/types";
import { authRoutes } from "../routes/auth";
import { healthRoutes } from "../routes/health";
import { incidentRoutes } from "../routes/incidents";
import { memberRoutes } from "../routes/members";
import { type Authenticator, requireAuth } from "./auth";
import { problemResponse } from "./problem";
import type { AppEnv } from "./types";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export type AppDeps = {
	// Usually authService.authenticate. Separate so tests can add fixed tokens.
	authenticate: Authenticator;
	authService: AuthService;
	incidentService: IncidentService;
	memberService: MemberService;
};

export const createApp = ({
	authenticate,
	authService,
	incidentService,
	memberService,
}: AppDeps) => {
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
	// Registered before requireAuth, so only these token-issuing routes are public.
	// Every /v1 route registered after it requires a token.
	app.route("/v1/auth", authRoutes(authService));
	app.use("/v1/*", requireAuth(authenticate));
	app.route("/v1/incidents", incidentRoutes(incidentService));
	app.route("/v1/members", memberRoutes(memberService));

	return app;
};
