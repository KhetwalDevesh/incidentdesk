import { OpenAPIRegistry, OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { PageQuerySchema, ProblemSchema } from "./common";
import { CreateIncidentRequestSchema, IncidentListSchema, IncidentSchema } from "./incidents";

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

export const buildOpenApiDocument = () =>
	new OpenApiGeneratorV31(registry.definitions).generateDocument({
		openapi: "3.1.0",
		info: { title: "IncidentDesk API", version: "0.1.0" },
	});
