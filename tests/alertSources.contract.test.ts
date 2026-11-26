import { beforeEach, describe, expect, it } from "vitest";
import { AlertSourceListSchema, CreatedAlertSourceSchema } from "../src/contract/alerts";
import { ProblemSchema } from "../src/contract/common";
import { authed, buildTestApp } from "./helpers";

const PATH = "/v1/alert-sources";

describe("alert sources contract", () => {
	let app: ReturnType<typeof buildTestApp>;

	beforeEach(() => {
		app = buildTestApp();
	});

	it("creates a source and returns its secret once, in the documented shape", async () => {
		const res = await app.request(PATH, authed("acme-admin", { name: "prometheus-prod" }));

		expect(res.status).toBe(201);
		const created = CreatedAlertSourceSchema.parse(await res.json());
		expect(created.name).toBe("prometheus-prod");
		expect(created.secret.length).toBeGreaterThanOrEqual(43);
		expect(created.secretHint).toBe(`…${created.secret.slice(-4)}`);
	});

	it("generates a different secret for every source", async () => {
		const a = await app.request(PATH, authed("acme-admin", { name: "a" }));
		const b = await app.request(PATH, authed("acme-admin", { name: "b" }));

		expect(CreatedAlertSourceSchema.parse(await a.json()).secret).not.toBe(
			CreatedAlertSourceSchema.parse(await b.json()).secret,
		);
	});

	it("lists sources without their secrets, oldest first", async () => {
		await app.request(PATH, authed("acme-admin", { name: "prometheus-prod" }));

		const res = await app.request(`${PATH}?limit=1`, authed("acme-admin"));

		expect(res.status).toBe(200);
		const page = AlertSourceListSchema.parse(await res.json());
		expect(page).toMatchObject({ total: 1, limit: 1, offset: 0 });
		expect(page.items[0]).not.toHaveProperty("secret");
	});

	it("returns 409 for a second source with the same name", async () => {
		await app.request(PATH, authed("acme-admin", { name: "prometheus-prod" }));

		const res = await app.request(PATH, authed("acme-admin", { name: "prometheus-prod" }));

		expect(res.status).toBe(409);
		expect(ProblemSchema.parse(await res.json()).code).toBe("CONFLICT");
	});

	it.each([
		["no token", PATH, { method: "POST" }, 401, "UNAUTHENTICATED"],
		["responder creates", PATH, authed("acme-responder", { name: "x" }), 403, "FORBIDDEN"],
		["responder lists", PATH, authed("acme-responder"), 403, "FORBIDDEN"],
		["missing name", PATH, authed("acme-admin", {}), 422, "VALIDATION_FAILED"],
		["blank name", PATH, authed("acme-admin", { name: "  " }), 422, "VALIDATION_FAILED"],
		["long name", PATH, authed("acme-admin", { name: "x".repeat(101) }), 422, "VALIDATION_FAILED"],
		[
			"unknown field",
			PATH,
			authed("acme-admin", { name: "x", secret: "mine" }),
			422,
			"VALIDATION_FAILED",
		],
		["bad page", `${PATH}?limit=0`, authed("acme-admin"), 422, "VALIDATION_FAILED"],
	])("returns a problem body for %s", async (_name, path, init, status, code) => {
		const res = await app.request(path, init);

		expect(res.status).toBe(status);
		expect(res.headers.get("Content-Type")).toContain("application/problem+json");
		expect(ProblemSchema.parse(await res.json()).code).toBe(code);
	});
});
