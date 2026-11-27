import { beforeEach, describe, expect, it } from "vitest";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema, MemberListSchema } from "../src/contract/members";
import { authed, buildTestApp, buildTestSystem, post, signup } from "./helpers";

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
		await addMember(admin, "grace@example.com", "responder");

		const res = await app.request("/v1/members?limit=10", authed(admin));

		expect(res.status).toBe(200);
		const list = MemberListSchema.parse(await res.json());
		expect(list).toMatchObject({ total: 2, limit: 10, offset: 0 });
		// Sorted by email: both can share a createdAt millisecond.
		const rows = list.items.map(({ email, role, status }) => ({ email, role, status }));
		expect(rows.sort((a, b) => a.email.localeCompare(b.email))).toEqual([
			{ email: "ada@example.com", role: "admin", status: "active" },
			{ email: "grace@example.com", role: "responder", status: "pending" },
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
		["POST", { email: "x@example.com", role: "responder" }],
	])("requires a token for %s /v1/members", async (method, body) => {
		const res = await app.request("/v1/members", {
			method,
			...(body ? post(body) : {}),
		});

		await expectProblem(res, 401, "UNAUTHENTICATED");
	});
});

// Spec: docs/features/login-rate-limiting.md
describe("login rate limiting", () => {
	let app: ReturnType<typeof buildTestApp>;
	let clock: Date;

	// As a trusted proxy would send it: the client's address is the rightmost entry.
	const from = (ip: string, body: unknown): RequestInit => {
		const init = post(body);
		return { ...init, headers: { ...(init.headers as object), "X-Forwarded-For": ip } };
	};

	const login = (email: string, password: string, ip = "203.0.113.1") =>
		app.request("/v1/auth/login", from(ip, { email, password }));

	const statuses = async (responses: (Response | Promise<Response>)[]) =>
		(await Promise.all(responses)).map((res) => res.status);

	const tooMany = async (res: Response, retryAfter: string) => {
		expect(res.status).toBe(429);
		expect(res.headers.get("Retry-After")).toBe(retryAfter);
		const body = ProblemSchema.parse(await res.json());
		expect(body).toMatchObject({
			code: "TOO_MANY_REQUESTS",
			status: 429,
			detail: "Too many attempts. Try again later.",
		});
		return body;
	};

	const advance = (ms: number) => {
		clock = new Date(clock.getTime() + ms);
	};

	beforeEach(async () => {
		clock = new Date("2026-01-10T12:00:00Z");
		app = buildTestSystem({ authNow: () => clock, trustedProxyHops: 1 }).app;
		await app.request(
			"/v1/auth/signup",
			from("198.51.100.200", { tenantName: "Acme", email: "ada@acme.example", password: PASSWORD }),
		);
	});

	it("locks an email after 5 failures, from any address, until 15 minutes pass", async () => {
		const failures = [];
		for (let n = 0; n < 5; n++) {
			failures.push((await login("ada@acme.example", "wrong password!", `203.0.113.${n}`)).status);
		}

		expect(failures).toEqual([401, 401, 401, 401, 401]);
		await tooMany(await login("ada@acme.example", "wrong password!", "203.0.113.50"), "900");
		// Even the right password: a locked email is not checked at all.
		await tooMany(await login("ada@acme.example", PASSWORD, "203.0.113.51"), "900");
		advance(10 * 60_000);
		await tooMany(await login("ada@acme.example", PASSWORD), "300");
		advance(5 * 60_000);
		expect((await login("ada@acme.example", PASSWORD)).status).toBe(200);
	});

	it("locks an unknown email exactly like a known one", async () => {
		for (let n = 0; n < 5; n++) {
			await login("ada@acme.example", "wrong password!", `203.0.113.${n}`);
			await login("nobody@acme.example", "wrong password!", `203.0.113.${n}`);
		}

		const known = await tooMany(await login("ada@acme.example", PASSWORD, "203.0.113.9"), "900");
		const unknown = await tooMany(
			await login("nobody@acme.example", PASSWORD, "203.0.113.9"),
			"900",
		);
		const { requestId: _known, ...knownRest } = known;
		const { requestId: _unknown, ...unknownRest } = unknown;
		expect(unknownRest).toEqual(knownRest);
	});

	it("clears an email's count on success", async () => {
		for (let n = 0; n < 4; n++) await login("ada@acme.example", "wrong password!");
		expect((await login("ada@acme.example", PASSWORD)).status).toBe(200);

		const after = [];
		for (let n = 0; n < 4; n++)
			after.push((await login("ada@acme.example", "wrong password!")).status);

		expect(after).toEqual([401, 401, 401, 401]);
	});

	it("locks an address after 30 failures across many emails, and a success does not reset it", async () => {
		for (let n = 0; n < 29; n++) await login(`user${n}@acme.example`, "wrong password!");
		expect((await login("ada@acme.example", PASSWORD)).status).toBe(200);
		expect((await login("last@acme.example", "wrong password!")).status).toBe(401);

		await tooMany(await login("someone@acme.example", "wrong password!"), "900");
		await tooMany(await login("ada@acme.example", PASSWORD), "900");
		expect((await login("ada@acme.example", PASSWORD, "203.0.113.99")).status).toBe(200);
	});

	it("locks setup-password by address after 10 bad tokens", async () => {
		const setup = (token: string) =>
			app.request("/v1/auth/setup-password", from("203.0.113.7", { token, password: PASSWORD }));

		expect(await statuses(Array.from({ length: 10 }, (_, n) => setup(`guess-${n}`)))).toEqual(
			Array.from({ length: 10 }, () => 401),
		);
		await tooMany(await setup("guess-11"), "900");
	});

	it("locks signup by address after 10 attempts, successful or not", async () => {
		const signupFrom = (n: number) =>
			app.request(
				"/v1/auth/signup",
				from("203.0.113.8", {
					tenantName: `Tenant ${n}`,
					// The first two share an email: the second fails with 409, and still counts.
					email: `owner${Math.max(n, 1)}@example.com`,
					password: PASSWORD,
				}),
			);

		const results = [];
		for (let n = 0; n < 10; n++) results.push((await signupFrom(n)).status);

		expect(results).toEqual([201, 409, 201, 201, 201, 201, 201, 201, 201, 201]);
		await tooMany(await signupFrom(10), "3600");
	});

	it("does not count requests that fail validation", async () => {
		for (let n = 0; n < 10; n++) {
			expect(
				(await app.request("/v1/auth/login", from("203.0.113.1", { email: "x" }))).status,
			).toBe(422);
		}

		expect((await login("ada@acme.example", PASSWORD)).status).toBe(200);
	});
});
