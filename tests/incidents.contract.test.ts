import { beforeEach, describe, expect, it } from "vitest";
import { ProblemSchema } from "../src/contract/common";
import { IncidentListSchema, IncidentSchema } from "../src/contract/incidents";
import { buildOpenApiDocument } from "../src/contract/openapi";
import { authed, buildTestApp } from "./helpers";

const validBody = { title: "Checkout is down", severity: "sev1" };

describe("incidents contract", () => {
	let app: ReturnType<typeof buildTestApp>;

	beforeEach(() => {
		app = buildTestApp();
	});

	it("creates an incident in the documented shape", async () => {
		const res = await app.request("/v1/incidents", authed("acme-responder", validBody));

		expect(res.status).toBe(201);
		const incident = IncidentSchema.parse(await res.json());
		expect(res.headers.get("Location")).toBe(`/v1/incidents/${incident.id}`);
	});

	it("lists incidents in the documented shape", async () => {
		await app.request("/v1/incidents", authed("acme-responder", validBody));

		const res = await app.request("/v1/incidents?limit=1", authed("acme-responder"));

		expect(res.status).toBe(200);
		expect(IncidentListSchema.parse(await res.json())).toMatchObject({ total: 1, limit: 1 });
	});

	it.each([
		["no token", "/v1/incidents", {}, 401, "UNAUTHENTICATED"],
		["viewer writes", "/v1/incidents", authed("acme-viewer", validBody), 403, "FORBIDDEN"],
		["bad body", "/v1/incidents", authed("acme-responder", {}), 422, "VALIDATION_FAILED"],
		["bad id", "/v1/incidents/nope", authed("acme-responder"), 422, "VALIDATION_FAILED"],
		["unknown route", "/nope", {}, 404, "NOT_FOUND"],
	])("returns a problem body for %s", async (_name, path, init, status, code) => {
		const res = await app.request(path, init);

		expect(res.status).toBe(status);
		expect(res.headers.get("Content-Type")).toContain("application/problem+json");
		expect(ProblemSchema.parse(await res.json()).code).toBe(code);
	});

	it("documents every route, and only real routes", () => {
		const served = app.routes
			.filter((route) => route.method !== "ALL")
			.map((route) => `${route.method} ${route.path.replace(/:(\w+)/g, "{$1}")}`);

		const paths = buildOpenApiDocument().paths ?? {};
		const documented = Object.entries(paths).flatMap(([path, item]) =>
			Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
		);

		expect(new Set(served)).toEqual(new Set(documented));
	});
});
