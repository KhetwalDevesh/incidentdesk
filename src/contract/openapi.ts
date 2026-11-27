import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
	AlertAcceptedSchema,
	AlertListQuerySchema,
	AlertListSchema,
	AlertPayloadSchema,
	AlertSourceIdSchema,
	AlertSourceListSchema,
	AlertSourceSchema,
	AlertWebhookHeadersSchema,
	CreateAlertSourceRequestSchema,
	CreatedAlertSourceSchema,
	UpdateAlertSourceRequestSchema,
} from "./alerts";
import { AuditEventListSchema, AuditEventQuerySchema } from "./audit";
import {
	AccessTokenSchema,
	LoginRequestSchema,
	SetupPasswordRequestSchema,
	SignupRequestSchema,
} from "./auth";
import { PageQuerySchema, ProblemSchema } from "./common";
import { DashboardQuerySchema, DashboardSchema } from "./dashboard";
import {
	AssignIncidentRequestSchema,
	CreateIncidentRequestSchema,
	IncidentListSchema,
	IncidentSchema,
} from "./incidents";
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
	NotificationChannelIdSchema,
	NotificationChannelListSchema,
	NotificationChannelSchema,
	NotificationDeliveryListSchema,
} from "./notificationChannels";
import {
	CreateOnCallOverrideRequestSchema,
	CreateOnCallScheduleRequestSchema,
	OnCallOverrideIdSchema,
	OnCallOverrideListQuerySchema,
	OnCallOverrideListSchema,
	OnCallOverrideSchema,
	OnCallQuerySchema,
	OnCallScheduleIdSchema,
	OnCallScheduleListSchema,
	OnCallScheduleSchema,
	OnCallSchema,
	UpdateOnCallScheduleRequestSchema,
} from "./onCall";
import {
	PostmortemDraftListSchema,
	PostmortemDraftSchema,
	PostmortemSchema,
	SavePostmortemRequestSchema,
} from "./postmortems";
import { SetSummaryRequestSchema, SummaryDraftListSchema, SummaryDraftSchema } from "./summaries";

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
		403: problem("The incident is assigned to someone else, and the caller is not an admin"),
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
		403: problem("The incident is assigned to someone else, and the caller is not an admin"),
		404: problem("No such incident in this tenant"),
		409: problem("Incident is already resolved, or changed while resolving"),
		422: problem("Id is not a UUID"),
	},
});

registry.registerPath({
	method: "post",
	path: "/v1/incidents/{id}/assign",
	summary: "Reassign an unresolved incident to a member, or unassign it",
	description:
		"Any member may reassign to any member of the tenant, themself included. Only an admin may unassign (null). Assigning the current assignee changes nothing.",
	security,
	request: {
		params: z.object({ id: z.uuid() }),
		body: { content: { "application/json": { schema: AssignIncidentRequestSchema } } },
	},
	responses: {
		200: json(IncidentSchema, "The incident with its new assignee"),
		...authErrors,
		403: problem("Only an admin can unassign an incident"),
		404: problem("No such incident or member in this tenant"),
		409: problem("Incident is resolved, or changed while reassigning"),
		422: problem("Id or body failed validation"),
	},
});

// AI summaries. Spec: docs/features/ai-summaries.md.
registry.registerPath({
	method: "post",
	path: "/v1/incidents/{id}/summary-drafts",
	summary: "Ask the AI for a fresh summary draft",
	description:
		"Returns the incident's pending draft if it has one. The draft is written in the background, and stays a suggestion until a member accepts it. Over the tenant's daily cap, the draft comes back skipped.",
	security,
	request: { params: z.object({ id: z.uuid() }) },
	responses: {
		202: json(SummaryDraftSchema, "The queued, pending or skipped draft"),
		...authErrors,
		404: problem("No such incident in this tenant"),
		422: problem("Id is not a UUID"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/incidents/{id}/summary-drafts",
	summary: "List an incident's summary drafts, newest first",
	security,
	request: { params: z.object({ id: z.uuid() }), query: PageQuerySchema },
	responses: {
		200: json(SummaryDraftListSchema, "A page of drafts"),
		...authErrors,
		404: problem("No such incident in this tenant"),
		422: problem("Id or query failed validation"),
	},
});

registry.registerPath({
	method: "put",
	path: "/v1/incidents/{id}/summary",
	summary: "Set an incident's summary, and optionally its severity",
	description:
		"Any member may write the summary by hand or accept a ready draft (draftId), editing it first if they like. A severity change is refused on a resolved incident.",
	security,
	request: {
		params: z.object({ id: z.uuid() }),
		body: { content: { "application/json": { schema: SetSummaryRequestSchema } } },
	},
	responses: {
		200: json(IncidentSchema, "The incident with its summary"),
		...authErrors,
		404: problem("No such incident, or draftId is not a ready draft of it"),
		409: problem("Severity change on a resolved incident, or the incident changed meanwhile"),
		422: problem("Id or body failed validation"),
	},
});

// AI postmortems. Spec: docs/features/ai-postmortems.md.
const incidentParams = z.object({ id: z.uuid() });

registry.registerPath({
	method: "post",
	path: "/v1/incidents/{id}/postmortem-drafts",
	summary: "Ask the AI for a fresh postmortem draft of a resolved incident",
	description:
		"Returns the pending draft if there is one. Written in the background, and only a suggestion until a member saves it. Over the tenant's daily AI cap, shared with summary drafts, the draft comes back skipped.",
	security,
	request: { params: incidentParams },
	responses: {
		202: json(PostmortemDraftSchema, "The queued, pending or skipped draft"),
		...authErrors,
		404: problem("No such incident in this tenant"),
		409: problem("The incident is not resolved"),
		422: problem("Id is not a UUID"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/incidents/{id}/postmortem-drafts",
	summary: "List an incident's postmortem drafts, newest first",
	security,
	request: { params: incidentParams, query: PageQuerySchema },
	responses: {
		200: json(PostmortemDraftListSchema, "A page of drafts"),
		...authErrors,
		404: problem("No such incident in this tenant"),
		422: problem("Id or query failed validation"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/incidents/{id}/postmortem",
	summary: "Get an incident's postmortem",
	security,
	request: { params: incidentParams },
	responses: {
		200: json(PostmortemSchema, "The postmortem"),
		...authErrors,
		404: problem("No such incident in this tenant, or no postmortem yet"),
		422: problem("Id is not a UUID"),
	},
});

registry.registerPath({
	method: "put",
	path: "/v1/incidents/{id}/postmortem",
	summary: "Save a resolved incident's postmortem, by hand or from a draft",
	description:
		"Any member may save. With only draftId, the body is the draft rendered as Markdown. A published postmortem stays published.",
	security,
	request: {
		params: incidentParams,
		body: { content: { "application/json": { schema: SavePostmortemRequestSchema } } },
	},
	responses: {
		200: json(PostmortemSchema, "The saved postmortem"),
		...authErrors,
		404: problem("No such incident, or draftId is not a ready draft of it"),
		409: problem("The incident is not resolved"),
		422: problem("Id or body failed validation"),
	},
});

registry.registerPath({
	method: "post",
	path: "/v1/incidents/{id}/postmortem/publish",
	summary: "Publish an incident's postmortem",
	description: "Any member may publish. Publishing again changes nothing.",
	security,
	request: { params: incidentParams },
	responses: {
		200: json(PostmortemSchema, "The published postmortem"),
		...authErrors,
		404: problem("No such incident in this tenant, or no postmortem yet"),
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

// Spec: docs/features/login-rate-limiting.md. The same answer for every limit and caller.
const tooManyAttempts = {
	...problem("Too many attempts from this email or address. Retry after the given time"),
	headers: z.object({
		"Retry-After": z.string().openapi({ description: "Whole seconds until the lock ends" }),
	}),
};

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
			429: tooManyAttempts,
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
	description: "Every member may list their tenant's members.",
	security,
	request: { query: PageQuerySchema },
	responses: {
		200: json(MemberListSchema, "A page of members"),
		...authErrors,
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
		422: problem("Request body failed validation, or the webhook URL's origin is not allowed"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/notification-channels/{id}/deliveries",
	summary: "List a notification channel's deliveries, newest first",
	security,
	request: { params: z.object({ id: NotificationChannelIdSchema }), query: PageQuerySchema },
	responses: {
		200: json(NotificationDeliveryListSchema, "A page of deliveries"),
		...authErrors,
		403: problem("Only admins can list deliveries"),
		404: problem("No such channel in the caller's tenant"),
		422: problem("Path or query failed validation"),
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
	method: "patch",
	path: "/v1/alert-sources/{id}",
	summary: "Link an alert source to an on-call schedule, or unlink it",
	security,
	request: {
		params: z.object({ id: AlertSourceIdSchema }),
		body: { content: { "application/json": { schema: UpdateAlertSourceRequestSchema } } },
	},
	responses: {
		200: json(AlertSourceSchema, "The alert source"),
		...authErrors,
		403: problem("Only admins can change alert sources"),
		404: problem("No such alert source or schedule in this tenant"),
		422: problem("Id or body failed validation"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/dashboard",
	summary: "Live counts of unresolved incidents, and who holds them",
	description:
		"Every member may read it. With from and to, every number counts only unresolved incidents opened in that range. Spec: docs/features/dashboard-stats.md.",
	security,
	request: { query: DashboardQuerySchema },
	responses: {
		200: json(DashboardSchema, "The dashboard"),
		...authErrors,
		422: problem(
			"Query failed validation: give both from and to, from before to, at most 90 days apart",
		),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/events",
	summary: "A live stream of the tenant's changes, as Server-Sent Events",
	description: [
		"Authenticate with the Authorization header, so read the stream with fetch, not EventSource.",
		"Events: ready and resync (data {}): fetch current state now;",
		"incident.opened, incident.acknowledged, incident.resolved and incident.reassigned ({ incident: Incident });",
		"dashboard (Dashboard, no window), at most once a second;",
		"on_call_schedule.created and on_call_schedule.updated ({ schedule: OnCallSchedule });",
		"on_call_schedule.deleted ({ id }); on_call_override.created ({ scheduleId, override: OnCallOverride });",
		"on_call_override.deleted ({ scheduleId, id }).",
		"incident.updated ({ incident }) when its summary or severity changes;",
		"summary_draft.ready ({ incidentId, draft: SummaryDraft }) when a draft finishes;",
		"postmortem_draft.ready ({ incidentId, draft: PostmortemDraft }) when a postmortem draft finishes;",
		"postmortem.updated ({ postmortem: Postmortem }) when a postmortem is saved or published.",
		"The stream closes when the token expires or the member is removed. There is no replay.",
		"Spec: docs/features/realtime-status.md.",
	].join(" "),
	security,
	responses: {
		200: {
			description: "An open event stream",
			content: { "text/event-stream": { schema: z.string() } },
		},
		...authErrors,
	},
});

// On-call schedules. Spec: docs/features/on-call-schedules.md.
const scheduleParams = z.object({ id: OnCallScheduleIdSchema });

registry.registerPath({
	method: "post",
	path: "/v1/on-call-schedules",
	summary: "Create an on-call schedule",
	security,
	request: {
		body: { content: { "application/json": { schema: CreateOnCallScheduleRequestSchema } } },
	},
	responses: {
		201: json(OnCallScheduleSchema, "Schedule created"),
		...authErrors,
		403: problem("Only admins can manage on-call schedules"),
		404: problem("A participant is not a member of the tenant"),
		409: problem("The tenant already has a schedule with this name"),
		422: problem("Request body failed validation"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/on-call-schedules",
	summary: "List the caller's tenant's on-call schedules, by name",
	security,
	request: { query: PageQuerySchema },
	responses: {
		200: json(OnCallScheduleListSchema, "A page of schedules"),
		...authErrors,
		422: problem("Query failed validation"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/on-call-schedules/{id}",
	summary: "Get one on-call schedule",
	security,
	request: { params: scheduleParams },
	responses: {
		200: json(OnCallScheduleSchema, "The schedule"),
		...authErrors,
		404: problem("No such schedule in this tenant"),
		422: problem("Id is not a UUID"),
	},
});

registry.registerPath({
	method: "patch",
	path: "/v1/on-call-schedules/{id}",
	summary: "Change an on-call schedule",
	description:
		"Changes who is on call from now on. Incidents already assigned keep their assignee.",
	security,
	request: {
		params: scheduleParams,
		body: { content: { "application/json": { schema: UpdateOnCallScheduleRequestSchema } } },
	},
	responses: {
		200: json(OnCallScheduleSchema, "The schedule"),
		...authErrors,
		403: problem("Only admins can manage on-call schedules"),
		404: problem("No such schedule in this tenant, or a participant is not a member"),
		409: problem("The tenant already has a schedule with this name"),
		422: problem("Id or body failed validation"),
	},
});

registry.registerPath({
	method: "delete",
	path: "/v1/on-call-schedules/{id}",
	summary: "Delete an on-call schedule with its rotation and overrides",
	description: "Linked alert sources are unlinked. Incidents keep their assignee.",
	security,
	request: { params: scheduleParams },
	responses: {
		204: { description: "Schedule deleted" },
		...authErrors,
		403: problem("Only admins can manage on-call schedules"),
		404: problem("No such schedule in this tenant"),
		422: problem("Id is not a UUID"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/on-call-schedules/{id}/on-call",
	summary: "Who is on call at a time, now by default",
	security,
	request: { params: scheduleParams, query: OnCallQuerySchema },
	responses: {
		200: json(OnCallSchema, "Who is on call"),
		...authErrors,
		404: problem("No such schedule in this tenant"),
		422: problem("Id or query failed validation"),
	},
});

registry.registerPath({
	method: "post",
	path: "/v1/on-call-schedules/{id}/overrides",
	summary: "Put a member on call for a time range",
	description:
		"A responder may add an override only for themself. An admin may add one for anyone.",
	security,
	request: {
		params: scheduleParams,
		body: { content: { "application/json": { schema: CreateOnCallOverrideRequestSchema } } },
	},
	responses: {
		201: json(OnCallOverrideSchema, "Override added"),
		...authErrors,
		403: problem("A responder may only add an override for themself"),
		404: problem("No such schedule or member in this tenant"),
		409: problem("The override overlaps another override in this schedule"),
		422: problem("Id or body failed validation, or the override has already ended"),
	},
});

registry.registerPath({
	method: "get",
	path: "/v1/on-call-schedules/{id}/overrides",
	summary: "List a schedule's overrides ending after `from`, by start time",
	security,
	request: { params: scheduleParams, query: OnCallOverrideListQuerySchema },
	responses: {
		200: json(OnCallOverrideListSchema, "A page of overrides"),
		...authErrors,
		404: problem("No such schedule in this tenant"),
		422: problem("Id or query failed validation"),
	},
});

registry.registerPath({
	method: "delete",
	path: "/v1/on-call-schedules/{id}/overrides/{overrideId}",
	summary: "Remove an override",
	description: "A responder may remove only their own override. An admin may remove any.",
	security,
	request: {
		params: z.object({ id: OnCallScheduleIdSchema, overrideId: OnCallOverrideIdSchema }),
	},
	responses: {
		204: { description: "Override removed" },
		...authErrors,
		403: problem("A responder may only remove their own override"),
		404: problem("No such override in this schedule"),
		422: problem("Id is not a UUID"),
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
