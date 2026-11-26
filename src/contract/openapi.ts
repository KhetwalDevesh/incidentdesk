import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
	AlertAcceptedSchema,
	AlertListQuerySchema,
	AlertListSchema,
	AlertPayloadSchema,
	AlertSourceListSchema,
	AlertWebhookHeadersSchema,
	CreateAlertSourceRequestSchema,
	CreatedAlertSourceSchema,
} from "./alerts";
import { AuditEventListSchema, AuditEventQuerySchema } from "./audit";
import {
	AccessTokenSchema,
	LoginRequestSchema,
	SetupPasswordRequestSchema,
	SignupRequestSchema,
} from "./auth";
import { PageQuerySchema, ProblemSchema } from "./common";
import { CreateIncidentRequestSchema, IncidentListSchema, IncidentSchema } from "./incidents";
import {
	AddMemberRequestSchema,
	BulkRemoveMembersRequestSchema,
	BulkUpdateMembersRequestSchema,
	MemberBatchSchema,
	MemberInviteSchema,
	MemberListSchema,
	MemberSchema,
	UpdateMemberRequestSchema,
} from "./members";
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

registry.registerPath({
	method: "get",
	path: "/v1/incidents/{id}/events",
	summary: "An incident's audit timeline, oldest first",
	security,
	request: { params: z.object({ id: z.uuid() }), query: PageQuerySchema },
	responses: {
		200: json(AuditEventListSchema, "A page of the incident's audit events"),
		...authErrors,
		404: problem("No such incident in this tenant"),
		422: problem("Id or query failed validation"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/audit-events",
	summary: "List the caller's tenant's audit events, newest first",
	description: "Every role may read the whole log. Entries are append-only and kept for 90 days.",
	security,
	request: { query: AuditEventQuerySchema },
	responses: {
		200: json(AuditEventListSchema, "A page of audit events"),
		...authErrors,
		422: problem("Query failed validation"),
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

const memberParams = z.object({ id: z.uuid() });
const adminOnly = { 403: problem("Only admins can manage members") };

registry.registerPath({
	method: "patch",
	path: "/v1/members/{id}",
	summary: "Change a member's role",
	security,
	request: {
		params: memberParams,
		body: { content: { "application/json": { schema: UpdateMemberRequestSchema } } },
	},
	responses: {
		200: json(MemberSchema, "The member with the new role"),
		...authErrors,
		...adminOnly,
		404: problem("No such member in this tenant"),
		409: problem("The caller's own role, or the tenant would have no active admin"),
		422: problem("Id or body failed validation"),
	},
});

registry.registerPath({
	method: "delete",
	path: "/v1/members/{id}",
	summary: "Remove a member, or cancel a pending invite",
	description: "The member is deleted. The same email can be invited again, as a new member.",
	security,
	request: { params: memberParams },
	responses: {
		204: { description: "Member removed" },
		...authErrors,
		...adminOnly,
		404: problem("No such member in this tenant"),
		409: problem("The caller themselves, or the tenant would have no active admin"),
		422: problem("Id failed validation"),
	},
});

const bulkErrors = {
	...authErrors,
	...adminOnly,
	404: problem("An id is not a member of this tenant. `errors` lists each one"),
	409: problem(
		"The caller is in the list, or the tenant would have no active admin. `errors` lists each item",
	),
	422: problem("Body failed validation, including a repeated id or more than 50 items"),
};

registry.registerPath({
	method: "patch",
	path: "/v1/members",
	summary: "Change several members' roles at once, all or nothing",
	security,
	request: {
		body: { content: { "application/json": { schema: BulkUpdateMembersRequestSchema } } },
	},
	responses: { 200: json(MemberBatchSchema, "Every change applied"), ...bulkErrors },
});

registry.registerPath({
	method: "post",
	path: "/v1/members/remove",
	summary: "Remove several members at once, all or nothing",
	security,
	request: {
		body: { content: { "application/json": { schema: BulkRemoveMembersRequestSchema } } },
	},
	responses: { 204: { description: "Every member removed" }, ...bulkErrors },
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

registry.registerPath({
	method: "get",
	path: "/v1/alert-sources",
	summary: "List the caller's tenant's alert sources",
	security,
	request: { query: PageQuerySchema },
	responses: {
		200: json(AlertSourceListSchema, "A page of alert sources"),
		...authErrors,
		403: problem("Only admins can list alert sources"),
		422: problem("Query failed validation"),
	},
});

registry.registerPath({
	method: "post",
	path: "/v1/alert-sources",
	summary: "Add a monitoring tool that may post alerts to the caller's tenant",
	security,
	request: {
		body: { content: { "application/json": { schema: CreateAlertSourceRequestSchema } } },
	},
	responses: {
		201: json(CreatedAlertSourceSchema, "Source added. The secret is shown this once"),
		...authErrors,
		403: problem("Only admins can add alert sources"),
		409: problem("The tenant already has a source with this name"),
		422: problem("Request body failed validation"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/alerts",
	summary: "List the caller's tenant's alerts, newest first",
	security,
	request: { query: AlertListQuerySchema },
	responses: {
		200: json(AlertListSchema, "A page of alerts"),
		...authErrors,
		403: problem("Only admins can list alerts"),
		422: problem("Query failed validation"),
	},
});

// Public: authenticated by the source's HMAC signature, not a bearer token.
registry.registerPath({
	method: "post",
	path: "/webhooks/alerts/{sourceId}",
	summary: "Accept a signed alert from a monitoring tool",
	description:
		"The signature is checked before the body is parsed. The alert is queued, and a worker groups it into an incident.",
	request: {
		params: z.object({ sourceId: z.uuid() }),
		headers: AlertWebhookHeadersSchema,
		body: { content: { "application/json": { schema: AlertPayloadSchema } } },
	},
	responses: {
		202: json(AlertAcceptedSchema, "Alert queued"),
		401: problem("Unknown source, stale timestamp, or missing or invalid signature"),
		413: problem("Body is larger than 64 KB"),
		422: problem("Body failed validation"),
	},
});

export const buildOpenApiDocument = () =>
	new OpenApiGeneratorV31(registry.definitions).generateDocument({
		openapi: "3.1.0",
		info: { title: "IncidentDesk API", version: "0.1.0" },
	});
