import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
	AccessTokenSchema,
	LoginRequestSchema,
	SetupPasswordRequestSchema,
	SignupRequestSchema,
} from "./auth";
import { PageQuerySchema, ProblemSchema } from "./common";
import { CreateIncidentRequestSchema, IncidentListSchema, IncidentSchema } from "./incidents";
import { AddMemberRequestSchema, MemberInviteSchema, MemberListSchema } from "./members";
import {
	CreateNotificationChannelRequestSchema,
	NotificationChannelListSchema,
	NotificationChannelSchema,
} from "./notificationChannels";

const registry = new OpenAPIRegistry();
const bearer = registry.registerComponent("securitySchemes", "bearerAuth", {
	type: "http",
	scheme: "bearer",
});
const security = [{ [bearer.name]: [] }];

const json = <T extends z.ZodType>(schema: T, description: string) => ({
	description,
	content: { "application/json": { schema } },
});

const problem = (description: string) => ({
	description,
	content: { "application/problem+json": { schema: ProblemSchema } },
});

const authErrors = { 401: problem("Missing or invalid token") };

registry.registerPath({
	method: "get",
	path: "/health",
	summary: "Liveness check",
	responses: { 200: json(z.strictObject({ status: z.literal("ok") }), "Service is up") },
});

registry.registerPath({
	method: "post",
	path: "/v1/incidents",
	summary: "Create an incident",
	security,
	request: {
		body: { content: { "application/json": { schema: CreateIncidentRequestSchema } } },
	},
	responses: {
		201: json(IncidentSchema, "Incident created"),
		...authErrors,
		403: problem("Role cannot create incidents"),
		422: problem("Request body failed validation"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/incidents",
	summary: "List incidents for the caller's tenant",
	security,
	request: { query: PageQuerySchema },
	responses: {
		200: json(IncidentListSchema, "A page of incidents"),
		...authErrors,
		422: problem("Query failed validation"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/incidents/{id}",
	summary: "Get one incident",
	security,
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(IncidentSchema, "The incident"),
		...authErrors,
		404: problem("No such incident in this tenant"),
		422: problem("Id is not a UUID"),
	},
});

registry.registerPath({
	method: "post",
	path: "/v1/incidents/{id}/acknowledge",
	summary: "Acknowledge an open incident",
	security,
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(IncidentSchema, "The acknowledged incident"),
		...authErrors,
		403: problem("Role cannot acknowledge incidents"),
		404: problem("No such incident in this tenant"),
		409: problem("Incident is not open"),
		422: problem("Id is not a UUID"),
	},
});

registry.registerPath({
	method: "post",
	path: "/v1/incidents/{id}/resolve",
	summary: "Resolve an open or acknowledged incident",
	security,
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		200: json(IncidentSchema, "The resolved incident"),
		...authErrors,
		403: problem("Role cannot resolve incidents"),
		404: problem("No such incident in this tenant"),
		409: problem("Incident is already resolved, or changed while resolving"),
		422: problem("Id is not a UUID"),
	},
});

// Public: these routes issue tokens, so they have no security requirement.
const tokenPath = (
	path: string,
	summary: string,
	body: z.ZodType,
	success: 200 | 201,
	errors: Record<number, ReturnType<typeof problem>>,
) =>
	registry.registerPath({
		method: "post",
		path,
		summary,
		request: { body: { content: { "application/json": { schema: body } } } },
		responses: {
			[success]: json(AccessTokenSchema, "An access token for the API"),
			...errors,
			422: problem("Request body failed validation"),
		},
	});

tokenPath(
	"/v1/auth/signup",
	"Create a tenant with the caller as its admin",
	SignupRequestSchema,
	201,
	{
		409: problem("Email is already registered"),
	},
);
tokenPath("/v1/auth/login", "Exchange email and password for a token", LoginRequestSchema, 200, {
	401: problem("Email or password is incorrect"),
});
tokenPath(
	"/v1/auth/setup-password",
	"Set a new member's password with a setup token",
	SetupPasswordRequestSchema,
	200,
	{ 401: problem("Setup token is invalid, used or expired") },
);

registry.registerPath({
	method: "get",
	path: "/v1/members",
	summary: "List members of the caller's tenant",
	security,
	request: { query: PageQuerySchema },
	responses: {
		200: json(MemberListSchema, "A page of members"),
		...authErrors,
		403: problem("Only admins can list members"),
		422: problem("Query failed validation"),
	},
});

registry.registerPath({
	method: "post",
	path: "/v1/members",
	summary: "Add a member to the caller's tenant",
	security,
	request: {
		body: { content: { "application/json": { schema: AddMemberRequestSchema } } },
	},
	responses: {
		201: json(MemberInviteSchema, "Member added, pending until they set a password"),
		...authErrors,
		403: problem("Only admins can add members"),
		409: problem("Email is already registered"),
		422: problem("Request body failed validation"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/notification-channels",
	summary: "List the caller's tenant's notification channels",
	security,
	request: { query: PageQuerySchema },
	responses: {
		200: json(NotificationChannelListSchema, "A page of notification channels"),
		...authErrors,
		403: problem("Only admins can list notification channels"),
		422: problem("Query failed validation"),
	},
});

registry.registerPath({
	method: "post",
	path: "/v1/notification-channels",
	summary: "Add a Slack incoming webhook to the caller's tenant",
	security,
	request: {
		body: {
			content: { "application/json": { schema: CreateNotificationChannelRequestSchema } },
		},
	},
	responses: {
		201: json(NotificationChannelSchema, "Channel added. The webhook URL is not returned"),
		...authErrors,
		403: problem("Only admins can add notification channels"),
		409: problem("The tenant already has a channel with this name"),
		422: problem("Request body failed validation"),
	},
});

export const buildOpenApiDocument = () =>
	new OpenApiGeneratorV31(registry.definitions).generateDocument({
		openapi: "3.1.0",
		info: { title: "IncidentDesk API", version: "0.1.0" },
	});
