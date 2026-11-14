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

	describe("acknowledge", () => {
		let incidentId: string;
		const ackPath = () => `/v1/incidents/${incidentId}/acknowledge`;

		beforeEach(async () => {
			const res = await app.request("/v1/incidents", authed("acme-responder", validBody));
			incidentId = IncidentSchema.parse(await res.json()).id;
		});

		it("starts with acknowledgedAt null", async () => {
			const res = await app.request(`/v1/incidents/${incidentId}`, authed("acme-responder"));

			expect(IncidentSchema.parse(await res.json()).acknowledgedAt).toBeNull();
		});

		it.each(["acme-responder", "acme-admin"])(
			"lets %s acknowledge an open incident",
			async (token) => {
				const res = await app.request(ackPath(), authed(token, {}));

				expect(res.status).toBe(200);
				const incident = IncidentSchema.parse(await res.json());
				expect(incident).toMatchObject({ id: incidentId, status: "acknowledged" });
				expect(incident.acknowledgedAt).not.toBeNull();
			},
		);

		it("persists the acknowledgement", async () => {
			await app.request(ackPath(), authed("acme-responder", {}));

			const res = await app.request(`/v1/incidents/${incidentId}`, authed("acme-viewer"));

			expect(IncidentSchema.parse(await res.json()).status).toBe("acknowledged");
		});

		it.each([
			["no token", {}, 401, "UNAUTHENTICATED"],
			["viewer acknowledges", authed("acme-viewer", {}), 403, "FORBIDDEN"],
		])("returns a problem body for %s", async (_name, init, status, code) => {
			const res = await app.request(ackPath(), init);

			expect(res.status).toBe(status);
			expect(ProblemSchema.parse(await res.json()).code).toBe(code);
		});

		it("returns 409 on a repeat acknowledge", async () => {
			await app.request(ackPath(), authed("acme-responder", {}));

			const res = await app.request(ackPath(), authed("acme-admin", {}));

			expect(res.status).toBe(409);
			expect(res.headers.get("Content-Type")).toContain("application/problem+json");
			expect(ProblemSchema.parse(await res.json()).code).toBe("CONFLICT");
		});

		it("lets exactly one of two simultaneous requests win", async () => {
			const responses = await Promise.all([
				app.request(ackPath(), authed("acme-responder", {})),
				app.request(ackPath(), authed("acme-admin", {})),
			]);

			expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
		});

		it.each([
			[
				"unknown id",
				"/v1/incidents/00000000-0000-4000-8000-000000000000/acknowledge",
				404,
				"NOT_FOUND",
			],
			["bad id", "/v1/incidents/nope/acknowledge", 422, "VALIDATION_FAILED"],
		])("returns a problem body for %s", async (_name, path, status, code) => {
			const res = await app.request(path, authed("acme-responder", {}));

			expect(res.status).toBe(status);
			expect(ProblemSchema.parse(await res.json()).code).toBe(code);
		});
	});

	describe("resolve", () => {
		let incidentId: string;
		const resolvePath = () => `/v1/incidents/${incidentId}/resolve`;

		beforeEach(async () => {
			const res = await app.request("/v1/incidents", authed("acme-responder", validBody));
			incidentId = IncidentSchema.parse(await res.json()).id;
		});

		it("starts with resolvedAt null", async () => {
			const res = await app.request(`/v1/incidents/${incidentId}`, authed("acme-responder"));

			expect(IncidentSchema.parse(await res.json()).resolvedAt).toBeNull();
		});

		it.each(["acme-responder", "acme-admin"])("lets %s resolve an open incident", async (token) => {
			const res = await app.request(resolvePath(), authed(token, {}));

			expect(res.status).toBe(200);
			const incident = IncidentSchema.parse(await res.json());
			expect(incident).toMatchObject({ id: incidentId, status: "resolved", acknowledgedAt: null });
			expect(incident.resolvedAt).not.toBeNull();
		});

		it("resolves an acknowledged incident and keeps acknowledgedAt", async () => {
			await app.request(`/v1/incidents/${incidentId}/acknowledge`, authed("acme-responder", {}));

			const res = await app.request(resolvePath(), authed("acme-responder", {}));

			expect(res.status).toBe(200);
			const incident = IncidentSchema.parse(await res.json());
			expect(incident.status).toBe("resolved");
			expect(incident.acknowledgedAt).not.toBeNull();
			expect(incident.resolvedAt).not.toBeNull();
		});

		it("persists the resolution", async () => {
			await app.request(resolvePath(), authed("acme-responder", {}));

			const res = await app.request(`/v1/incidents/${incidentId}`, authed("acme-viewer"));

			expect(IncidentSchema.parse(await res.json()).status).toBe("resolved");
		});

		it.each([
			["no token", {}, 401, "UNAUTHENTICATED"],
			["viewer resolves", authed("acme-viewer", {}), 403, "FORBIDDEN"],
		])("returns a problem body for %s", async (_name, init, status, code) => {
			const res = await app.request(resolvePath(), init);

			expect(res.status).toBe(status);
			expect(ProblemSchema.parse(await res.json()).code).toBe(code);
		});

		it("returns 409 on a repeat resolve", async () => {
			await app.request(resolvePath(), authed("acme-responder", {}));

			const res = await app.request(resolvePath(), authed("acme-admin", {}));

			expect(res.status).toBe(409);
			expect(res.headers.get("Content-Type")).toContain("application/problem+json");
			expect(ProblemSchema.parse(await res.json()).code).toBe("CONFLICT");
		});

		it("refuses to acknowledge a resolved incident", async () => {
			await app.request(resolvePath(), authed("acme-responder", {}));

			const res = await app.request(
				`/v1/incidents/${incidentId}/acknowledge`,
				authed("acme-responder", {}),
			);

			expect(res.status).toBe(409);
			expect(ProblemSchema.parse(await res.json()).code).toBe("CONFLICT");
		});

		it("lets exactly one of two simultaneous requests win", async () => {
			const responses = await Promise.all([
				app.request(resolvePath(), authed("acme-responder", {})),
				app.request(resolvePath(), authed("acme-admin", {})),
			]);

			expect(responses.map((res) => res.status).sort()).toEqual([200, 409]);
		});

		it.each([
			[
				"unknown id",
				"/v1/incidents/00000000-0000-4000-8000-000000000000/resolve",
				404,
				"NOT_FOUND",
			],
			["bad id", "/v1/incidents/nope/resolve", 422, "VALIDATION_FAILED"],
		])("returns a problem body for %s", async (_name, path, status, code) => {
			const res = await app.request(path, authed("acme-responder", {}));

			expect(res.status).toBe(status);
			expect(ProblemSchema.parse(await res.json()).code).toBe(code);
		});
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
