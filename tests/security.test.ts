import { randomUUID } from "node:crypto";
import { sign } from "hono/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { IncidentListSchema, IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema, MemberListSchema } from "../src/contract/members";
import { authed, buildTestApp, post, signup, TEST_JWT_SECRET } from "./helpers";

const PASSWORD = "correct horse battery";

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

	it("hides another tenant's incident from acknowledge, and leaves it open", async () => {
		const res = await app.request(
			`/v1/incidents/${incidentId}/acknowledge`,
			authed("globex-responder", {}),
		);

		expect(res.status).toBe(404);
		const check = await app.request(`/v1/incidents/${incidentId}`, authed("acme-responder"));
		expect(IncidentSchema.parse(await check.json()).status).toBe("open");
	});

	it("hides another tenant's incident from resolve, and leaves it open", async () => {
		const res = await app.request(
			`/v1/incidents/${incidentId}/resolve`,
			authed("globex-responder", {}),
		);

		expect(res.status).toBe(404);
		const check = await app.request(`/v1/incidents/${incidentId}`, authed("acme-responder"));
		const incident = IncidentSchema.parse(await check.json());
		expect(incident).toMatchObject({ status: "open", resolvedAt: null });
	});

	it("never exposes resolvedBy, even when the body tries to set it", async () => {
		const res = await app.request(
			`/v1/incidents/${incidentId}/resolve`,
			authed("acme-responder", { resolvedBy: "user-999", tenantId: "tenant-globex" }),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).not.toHaveProperty("resolvedBy");
	});

	it("never exposes acknowledgedBy, even when the body tries to set it", async () => {
		const res = await app.request(
			`/v1/incidents/${incidentId}/acknowledge`,
			authed("acme-responder", { acknowledgedBy: "user-999", tenantId: "tenant-globex" }),
		);

		expect(res.status).toBe(200);
		expect(await res.json()).not.toHaveProperty("acknowledgedBy");
	});

	it("rejects a client-supplied tenantId", async () => {
		const res = await app.request(
			"/v1/incidents",
			authed("globex-responder", { ...validBody, tenantId: "tenant-acme" }),
		);

		expect(res.status).toBe(422);
	});
});

describe("access tokens", () => {
	let app: ReturnType<typeof buildTestApp>;
	let token: string;

	beforeEach(async () => {
		app = buildTestApp();
		token = await signup(app, "ada@example.com");
	});

	const statusWith = async (candidate: string) =>
		(await app.request("/v1/incidents", authed(candidate))).status;

	const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const claims = () => {
		const [, payload] = token.split(".");
		return JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
	};

	it("accepts the issued token", async () => {
		expect(await statusWith(token)).toBe(200);
	});

	it("rejects a token with a tampered payload", async () => {
		const [header, , signature] = token.split(".");
		const forged = `${header}.${base64url({ ...claims(), tid: randomUUID() })}.${signature}`;

		expect(await statusWith(forged)).toBe(401);
	});

	it("rejects an unsigned alg:none token", async () => {
		const unsigned = `${base64url({ alg: "none", typ: "JWT" })}.${base64url(claims())}.`;

		expect(await statusWith(unsigned)).toBe(401);
	});

	it("rejects a token signed with another algorithm, even with the right secret", async () => {
		expect(await statusWith(await sign(claims(), TEST_JWT_SECRET, "HS512"))).toBe(401);
	});

	it("rejects a token signed with another secret", async () => {
		expect(
			await statusWith(await sign(claims(), "another-secret-that-is-32-characters!", "HS256")),
		).toBe(401);
	});

	it("rejects a validly signed token for a user that does not exist", async () => {
		const ghost = await sign({ ...claims(), sub: randomUUID() }, TEST_JWT_SECRET, "HS256");

		expect(await statusWith(ghost)).toBe(401);
	});

	it("rejects an expired token", async () => {
		const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
		const pastApp = buildTestApp({ tokenNowMs: () => twoHoursAgo });
		const expired = await signup(pastApp, "old@example.com");

		expect((await pastApp.request("/v1/incidents", authed(expired))).status).toBe(401);
	});

	it("keeps tenant identity out of the token's control: incidents stay in the signer's tenant", async () => {
		const other = await signup(app, "linus@example.com", "Globex");
		await app.request("/v1/incidents", authed(token, validBody));

		const res = await app.request("/v1/incidents", authed(other));

		expect(IncidentListSchema.parse(await res.json()).total).toBe(0);
	});
});

describe("login responses", () => {
	it("are identical for a wrong password, an unknown email and a pending member", async () => {
		const app = buildTestApp();
		const admin = await signup(app, "ada@example.com");
		await app.request("/v1/members", authed(admin, { email: "grace@example.com", role: "viewer" }));

		const bodies = await Promise.all(
			[
				{ email: "ada@example.com", password: "wrong password!" },
				{ email: "nobody@example.com", password: PASSWORD },
				{ email: "grace@example.com", password: PASSWORD },
			].map(async (body) => {
				const res = await app.request("/v1/auth/login", post(body));
				expect(res.status).toBe(401);
				// requestId differs per request by design; everything else must match.
				const { requestId: _ignored, ...rest } = ProblemSchema.parse(await res.json());
				return rest;
			}),
		);

		expect(bodies[0]).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[2]).toEqual(bodies[0]);
	});
});

describe("member management", () => {
	let app: ReturnType<typeof buildTestApp>;
	let admin: string;

	beforeEach(async () => {
		app = buildTestApp();
		admin = await signup(app, "ada@example.com");
	});

	const invite = async (adminToken: string, email: string, role: string) => {
		const res = await app.request("/v1/members", authed(adminToken, { email, role }));
		return MemberInviteSchema.parse(await res.json());
	};

	const activate = async (setupToken: string) => {
		const res = await app.request(
			"/v1/auth/setup-password",
			post({ token: setupToken, password: PASSWORD }),
		);
		return AccessTokenSchema.parse(await res.json()).accessToken;
	};

	it.each(["viewer", "responder"])("forbids a %s from listing or adding members", async (role) => {
		const member = await activate((await invite(admin, `${role}@example.com`, role)).setupToken);

		expect((await app.request("/v1/members", authed(member))).status).toBe(403);
		const add = await app.request(
			"/v1/members",
			authed(member, { email: "x@example.com", role: "admin" }),
		);
		expect(add.status).toBe(403);
	});

	it("keeps each tenant's members separate", async () => {
		const globex = await signup(app, "linus@example.com", "Globex");
		await invite(globex, "grace@example.com", "viewer");

		const acme = MemberListSchema.parse(
			await (await app.request("/v1/members", authed(admin))).json(),
		);
		const other = MemberListSchema.parse(
			await (await app.request("/v1/members", authed(globex))).json(),
		);

		expect(acme.items.map((m) => m.email)).toEqual(["ada@example.com"]);
		// Sorted: both can share a createdAt millisecond, and order is not what this test is about.
		expect(other.items.map((m) => m.email).sort()).toEqual([
			"grace@example.com",
			"linus@example.com",
		]);
	});

	it("never returns password hashes", async () => {
		await activate((await invite(admin, "grace@example.com", "viewer")).setupToken);

		const body = await (await app.request("/v1/members", authed(admin))).text();

		expect(body).not.toMatch(/argon2|password/i);
	});

	it("accepts a setup token only once", async () => {
		const { setupToken } = await invite(admin, "grace@example.com", "viewer");
		await activate(setupToken);

		const again = await app.request(
			"/v1/auth/setup-password",
			post({ token: setupToken, password: PASSWORD }),
		);

		expect(again.status).toBe(401);
	});

	it("lets exactly one of two simultaneous setup-token uses win", async () => {
		const { setupToken } = await invite(admin, "grace@example.com", "viewer");

		const responses = await Promise.all(
			[1, 2].map(() =>
				app.request("/v1/auth/setup-password", post({ token: setupToken, password: PASSWORD })),
			),
		);

		expect(responses.map((res) => res.status).sort()).toEqual([200, 401]);
	});

	it("leaves no route public except the token-issuing ones", async () => {
		expect((await app.request("/v1/auth/unknown", post({}))).status).toBe(401);
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
