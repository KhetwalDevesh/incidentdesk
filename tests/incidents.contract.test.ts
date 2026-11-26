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

			const res = await app.request(`/v1/incidents/${incidentId}`, authed("acme-responder-2"));

			expect(IncidentSchema.parse(await res.json()).status).toBe("acknowledged");
		});

		// Acting on an assigned incident: tests/onCall.contract.test.ts.
		it.each([["no token", {}, 401, "UNAUTHENTICATED"]])(
			"returns a problem body for %s",
			async (_name, init, status, code) => {
				const res = await app.request(ackPath(), init);

				expect(res.status).toBe(status);
				expect(ProblemSchema.parse(await res.json()).code).toBe(code);
			},
		);

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

			const res = await app.request(`/v1/incidents/${incidentId}`, authed("acme-responder-2"));

			expect(IncidentSchema.parse(await res.json()).status).toBe("resolved");
		});

		it.each([["no token", {}, 401, "UNAUTHENTICATED"]])(
			"returns a problem body for %s",
			async (_name, init, status, code) => {
				const res = await app.request(resolvePath(), init);

				expect(res.status).toBe(status);
				expect(ProblemSchema.parse(await res.json()).code).toBe(code);
			},
		);

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

	// Reassigning to real members: tests/onCall.contract.test.ts. The fixed-token tenant has no
	// members, which these cases rely on.
	describe("assign", () => {
		let incidentId: string;
		const assignPath = () => `/v1/incidents/${incidentId}/assign`;

		beforeEach(async () => {
			const res = await app.request("/v1/incidents", authed("acme-responder", validBody));
			incidentId = IncidentSchema.parse(await res.json()).id;
		});

		it("opens unassigned when the tenant has no schedule", async () => {
			const res = await app.request(`/v1/incidents/${incidentId}`, authed("acme-responder"));

			expect(IncidentSchema.parse(await res.json()).assignee).toBeNull();
		});

		it("returns the incident unchanged when it already has that assignee", async () => {
			const res = await app.request(assignPath(), authed("acme-admin", { assigneeId: null }));

			expect(res.status).toBe(200);
			expect(IncidentSchema.parse(await res.json())).toMatchObject({
				id: incidentId,
				assignee: null,
			});
		});

		it.each([
			["no token", () => ({}), 401, "UNAUTHENTICATED"],
			[
				"a responder unassigning",
				() => authed("acme-responder", { assigneeId: null }),
				403,
				"FORBIDDEN",
			],
			[
				"an unknown member",
				() => authed("acme-responder", { assigneeId: "00000000-0000-4000-8000-000000000001" }),
				404,
				"NOT_FOUND",
			],
			["a missing assigneeId", () => authed("acme-responder", {}), 422, "VALIDATION_FAILED"],
			[
				"a malformed assigneeId",
				() => authed("acme-responder", { assigneeId: "grace" }),
				422,
				"VALIDATION_FAILED",
			],
		])("returns a problem body for %s", async (_name, init, status, code) => {
			const res = await app.request(assignPath(), init());

			expect(res.status).toBe(status);
			expect(ProblemSchema.parse(await res.json()).code).toBe(code);
		});

		it("names the field when the member is unknown", async () => {
			const res = await app.request(
				assignPath(),
				authed("acme-responder", { assigneeId: "00000000-0000-4000-8000-000000000001" }),
			);

			expect(ProblemSchema.parse(await res.json()).errors).toEqual([
				{ path: "assigneeId", message: "Member not found" },
			]);
		});

		it("returns 409 for a resolved incident, and 404 for an unknown or another tenant's", async () => {
			await app.request(`/v1/incidents/${incidentId}/resolve`, authed("acme-responder", {}));
			const body = { assigneeId: "00000000-0000-4000-8000-000000000001" };

			const resolved = await app.request(assignPath(), authed("acme-admin", body));
			const unknown = await app.request(
				"/v1/incidents/00000000-0000-4000-8000-000000000000/assign",
				authed("acme-admin", body),
			);
			const foreign = await app.request(assignPath(), authed("globex-responder", body));

			expect(resolved.status).toBe(409);
			expect(ProblemSchema.parse(await resolved.json()).detail).toBe(
				"A resolved incident cannot be reassigned",
			);
			expect(unknown.status).toBe(404);
			expect(foreign.status).toBe(404);
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
