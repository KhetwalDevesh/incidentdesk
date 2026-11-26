import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { AlertIngestService, AlertService, AlertSourceService } from "../domain/alerts/types";
import type { AuditService } from "../domain/audit/types";
import type { AuthService, MemberService } from "../domain/auth/types";
import type { DashboardService } from "../domain/dashboard/types";
import type { EventHub } from "../domain/events/types";
import type { IncidentService } from "../domain/incidents/types";
import type { NotificationChannelService } from "../domain/notifications/types";
import type { OnCallScheduleService } from "../domain/onCall/types";
import { alertSourceRoutes } from "../routes/alertSources";
import { alertRoutes } from "../routes/alerts";
import { alertWebhookRoutes } from "../routes/alertWebhooks";
import { auditRoutes } from "../routes/audit";
import { authRoutes } from "../routes/auth";
import { dashboardRoutes } from "../routes/dashboard";
import { eventRoutes } from "../routes/events";
import { healthRoutes } from "../routes/health";
import { incidentRoutes } from "../routes/incidents";
import { memberRoutes } from "../routes/members";
import { notificationChannelRoutes } from "../routes/notificationChannels";
import { onCallScheduleRoutes } from "../routes/onCallSchedules";
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
	notificationChannelService: NotificationChannelService;
	alertSourceService: AlertSourceService;
	alertService: AlertService;
	alertIngestService: AlertIngestService;
	auditService: AuditService;
	onCallScheduleService: OnCallScheduleService;
	dashboardService: DashboardService;
	eventHub: EventHub;
};

export const createApp = ({
	authenticate,
	authService,
	incidentService,
	memberService,
	notificationChannelService,
	alertSourceService,
	alertService,
	alertIngestService,
	auditService,
	onCallScheduleService,
	dashboardService,
	eventHub,
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
	// Outside /v1 and before requireAuth: monitoring tools sign requests instead of holding a token.
	app.route("/webhooks/alerts", alertWebhookRoutes(alertIngestService));
	app.use("/v1/*", requireAuth(authenticate));
	app.route("/v1/incidents", incidentRoutes(incidentService));
	app.route("/v1/members", memberRoutes(memberService));
	app.route("/v1/notification-channels", notificationChannelRoutes(notificationChannelService));
	app.route("/v1/alert-sources", alertSourceRoutes(alertSourceService));
	app.route("/v1/alerts", alertRoutes(alertService));
	app.route("/v1/on-call-schedules", onCallScheduleRoutes(onCallScheduleService));
	app.route("/v1/dashboard", dashboardRoutes(dashboardService));
	app.route("/v1/events", eventRoutes(eventHub));
	// /v1/audit-events and /v1/incidents/{id}/events.
	app.route("/v1", auditRoutes(auditService));

	return app;
};
