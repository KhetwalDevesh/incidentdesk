import { beforeEach, describe, expect, it } from "vitest";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema, MemberListSchema } from "../src/contract/members";
import { authed, buildTestApp, post, signup } from "./helpers";

const PASSWORD = "correct horse battery";

describe("auth and members contract", () => {
	let app: ReturnType<typeof buildTestApp>;

	beforeEach(() => {
		app = buildTestApp();
	});

	const expectProblem = async (res: Response, status: number, code: string) => {
		expect(res.status).toBe(status);
		expect(res.headers.get("Content-Type")).toContain("application/problem+json");
		expect(ProblemSchema.parse(await res.json()).code).toBe(code);
	};

	const addMember = async (adminToken: string, email: string, role = "responder") => {
		const res = await app.request("/v1/members", authed(adminToken, { email, role }));
		return { res, invite: res.status === 201 ? MemberInviteSchema.parse(await res.json()) : null };
	};

	it("signs up, and the token works on incidents", async () => {
		const res = await app.request(
			"/v1/auth/signup",
			post({ tenantName: "Acme", email: "Ada@Example.com ", password: PASSWORD }),
		);

		expect(res.status).toBe(201);
		const { accessToken, tokenType } = AccessTokenSchema.parse(await res.json());
		expect(tokenType).toBe("Bearer");
		const created = await app.request(
			"/v1/incidents",
			authed(accessToken, { title: "Checkout is down", severity: "sev1" }),
		);
		expect(created.status).toBe(201);
		IncidentSchema.parse(await created.json());
	});

	it("logs in with a normalized email", async () => {
		await signup(app, "ada@example.com");

		const res = await app.request(
			"/v1/auth/login",
			post({ email: " ADA@example.com", password: PASSWORD }),
		);

		expect(res.status).toBe(200);
		const { accessToken } = AccessTokenSchema.parse(await res.json());
		expect((await app.request("/v1/incidents", authed(accessToken))).status).toBe(200);
	});

	it("adds a pending member who sets a password, then logs in", async () => {
		const admin = await signup(app, "ada@example.com");

		const { res, invite } = await addMember(admin, "grace@example.com");

		expect(res.status).toBe(201);
		expect(invite).toMatchObject({
			email: "grace@example.com",
			role: "responder",
			status: "pending",
		});
		const setup = await app.request(
			"/v1/auth/setup-password",
			post({ token: invite?.setupToken, password: PASSWORD }),
		);
		expect(setup.status).toBe(200);
		const { accessToken } = AccessTokenSchema.parse(await setup.json());
		expect((await app.request("/v1/incidents", authed(accessToken))).status).toBe(200);

		const login = await app.request(
			"/v1/auth/login",
			post({ email: "grace@example.com", password: PASSWORD }),
		);
		expect(login.status).toBe(200);
	});

	it("lists members with their status", async () => {
		const admin = await signup(app, "ada@example.com");
		await addMember(admin, "grace@example.com", "viewer");

		const res = await app.request("/v1/members?limit=10", authed(admin));

		expect(res.status).toBe(200);
		const list = MemberListSchema.parse(await res.json());
		expect(list).toMatchObject({ total: 2, limit: 10, offset: 0 });
		// Sorted by email: both can share a createdAt millisecond.
		const rows = list.items.map(({ email, role, status }) => ({ email, role, status }));
		expect(rows.sort((a, b) => a.email.localeCompare(b.email))).toEqual([
			{ email: "ada@example.com", role: "admin", status: "active" },
			{ email: "grace@example.com", role: "viewer", status: "pending" },
		]);
	});

	it.each([
		[
			"signup with a short password",
			"/v1/auth/signup",
			{ tenantName: "A", email: "a@b.co", password: "short" },
		],
		[
			"signup with a bad email",
			"/v1/auth/signup",
			{ tenantName: "A", email: "nope", password: PASSWORD },
		],
		[
			"signup with an extra field",
			"/v1/auth/signup",
			{ tenantName: "A", email: "a@b.co", password: PASSWORD, role: "admin" },
		],
		["login without a password", "/v1/auth/login", { email: "a@b.co" }],
		["setup with a short password", "/v1/auth/setup-password", { token: "x", password: "short" }],
	])("returns 422 for %s", async (_name, path, body) => {
		await expectProblem(await app.request(path, post(body)), 422, "VALIDATION_FAILED");
	});

	it("returns 409 when signing up with a registered email", async () => {
		await signup(app, "ada@example.com");

		const res = await app.request(
			"/v1/auth/signup",
			post({ tenantName: "Other", email: "ADA@example.com", password: PASSWORD }),
		);

		await expectProblem(res, 409, "CONFLICT");
	});

	it("returns 409 when adding a registered email", async () => {
		const admin = await signup(app, "ada@example.com");
		await signup(app, "linus@example.com", "Globex");

		const { res } = await addMember(admin, "linus@example.com");

		await expectProblem(res, 409, "CONFLICT");
	});

	it("returns 401 for a wrong password", async () => {
		await signup(app, "ada@example.com");

		const res = await app.request(
			"/v1/auth/login",
			post({ email: "ada@example.com", password: "wrong password!" }),
		);

		await expectProblem(res, 401, "UNAUTHENTICATED");
	});

	it("returns 401 for an unknown setup token", async () => {
		const res = await app.request(
			"/v1/auth/setup-password",
			post({ token: "not-a-real-token", password: PASSWORD }),
		);

		await expectProblem(res, 401, "UNAUTHENTICATED");
	});

	it.each([
		["GET", undefined],
		["POST", { email: "x@example.com", role: "viewer" }],
	])("requires a token for %s /v1/members", async (method, body) => {
		const res = await app.request("/v1/members", {
			method,
			...(body ? post(body) : {}),
		});

		await expectProblem(res, 401, "UNAUTHENTICATED");
	});
});
