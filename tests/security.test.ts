import { beforeEach, describe, expect, it } from "vitest";
import { IncidentListSchema, IncidentSchema } from "../src/contract/incidents";
import { authed, buildTestApp } from "./helpers";

const validBody = { title: "Checkout is down", severity: "sev1" };

describe("tenant isolation", () => {
	let app: ReturnType<typeof buildTestApp>;
	let incidentId: string;

	beforeEach(async () => {
		app = buildTestApp();
		const res = await app.request("/v1/incidents", authed("acme-responder", validBody));
		incidentId = IncidentSchema.parse(await res.json()).id;
	});

	it("hides another tenant's incident behind a 404", async () => {
		const res = await app.request(`/v1/incidents/${incidentId}`, authed("globex-responder"));

		expect(res.status).toBe(404);
	});

	it("excludes another tenant's incidents from lists", async () => {
		const res = await app.request("/v1/incidents", authed("globex-responder"));

		expect(IncidentListSchema.parse(await res.json()).total).toBe(0);
	});

	it("rejects a client-supplied tenantId", async () => {
		const res = await app.request(
			"/v1/incidents",
			authed("globex-responder", { ...validBody, tenantId: "tenant-acme" }),
		);

		expect(res.status).toBe(422);
	});
});

describe("request ids", () => {
	it("echoes a well-formed id", async () => {
		const res = await buildTestApp().request("/health", {
			headers: { "X-Request-ID": "trace-12345678" },
		});

		expect(res.headers.get("X-Request-ID")).toBe("trace-12345678");
	});

	it("replaces a malformed id", async () => {
		const res = await buildTestApp().request("/health", {
			headers: { "X-Request-ID": "bad id\twith spaces" },
		});

		expect(res.headers.get("X-Request-ID")).not.toContain("bad");
	});
});
