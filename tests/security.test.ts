import { randomUUID } from "node:crypto";
import { sign } from "hono/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AlertAcceptedSchema,
	AlertListSchema,
	AlertSourceListSchema,
} from "../src/contract/alerts";
import { AuditEventListSchema } from "../src/contract/audit";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { IncidentListSchema, IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema, MemberListSchema } from "../src/contract/members";
import { NotificationChannelListSchema } from "../src/contract/notificationChannels";
import type { TenantId } from "../src/domain/shared/identity";
import {
	addAlertSource,
	authed,
	buildTestApp,
	buildTestSystem,
	post,
	signedAlert,
	signup,
	TEST_JWT_SECRET,
} from "./helpers";

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

describe("notification channels", () => {
	const SECRET_URL = "https://hooks.slack.com/services/T000/B000/s3cretTokenPart";
	const PATH = "/v1/notification-channels";
	let app: ReturnType<typeof buildTestApp>;

	beforeEach(() => {
		app = buildTestApp();
	});

	it("never returns the webhook URL, on create or list", async () => {
		const created = await app.request(
			PATH,
			authed("acme-admin", { name: "#incidents", webhookUrl: SECRET_URL }),
		);
		const listed = await app.request(PATH, authed("acme-admin"));

		expect(created.status).toBe(201);
		for (const body of [await created.text(), await listed.text()]) {
			expect(body).not.toContain("s3cretTokenPart");
			expect(body).not.toContain("hooks.slack.com");
			expect(body).not.toContain("Ciphertext");
		}
	});

	it("keeps each tenant's channels separate", async () => {
		await app.request(PATH, authed("acme-admin", { name: "#incidents", webhookUrl: SECRET_URL }));
		const globexAdmin = await signup(app, "admin@globex.example", "Globex");

		const res = await app.request(PATH, authed(globexAdmin));

		expect(NotificationChannelListSchema.parse(await res.json()).total).toBe(0);
		const sameName = await app.request(
			PATH,
			authed(globexAdmin, { name: "#incidents", webhookUrl: SECRET_URL }),
		);
		expect(sameName.status).toBe(201);
	});

	it("rejects a client-supplied tenantId", async () => {
		const res = await app.request(
			PATH,
			authed("acme-admin", { name: "#x", webhookUrl: SECRET_URL, tenantId: "tenant-globex" }),
		);

		expect(res.status).toBe(422);
		const list = await app.request(PATH, authed("acme-admin"));
		expect(NotificationChannelListSchema.parse(await list.json()).total).toBe(0);
	});

	it("refuses viewers and responders, even with a valid body", async () => {
		for (const token of ["acme-viewer", "acme-responder"]) {
			const res = await app.request(
				PATH,
				authed(token, { name: "#sneaky", webhookUrl: SECRET_URL }),
			);
			expect(res.status).toBe(403);
		}
		const list = await app.request(PATH, authed("acme-admin"));
		expect(NotificationChannelListSchema.parse(await list.json()).total).toBe(0);
	});
});

describe("alert ingestion", () => {
	const alert = { dedupKey: "db-cpu-high", title: "DB CPU above 90%", severity: "sev1" };
	let system: ReturnType<typeof buildTestSystem>;
	let globexAdmin: string;

	beforeEach(async () => {
		system = buildTestSystem();
		globexAdmin = await signup(system.app, "admin@globex.example", "Globex");
	});

	const incidentsOf = async (token: string) =>
		IncidentListSchema.parse(
			await (await system.app.request("/v1/incidents", authed(token))).json(),
		);

	it("never returns a source secret after create, nor its ciphertext", async () => {
		const { secret } = await addAlertSource(system.app, "acme-admin");

		const listed = await system.app.request("/v1/alert-sources", authed("acme-admin"));

		const body = await listed.text();
		expect(body).not.toContain(secret);
		expect(body).not.toContain("iphertext");
	});

	it("keeps each tenant's sources and alerts separate", async () => {
		const { sourceId, secret } = await addAlertSource(system.app, "acme-admin");
		await system.app.request(`/webhooks/alerts/${sourceId}`, signedAlert(secret, alert));

		const sources = await system.app.request("/v1/alert-sources", authed(globexAdmin));
		const alerts = await system.app.request("/v1/alerts", authed(globexAdmin));

		expect(AlertSourceListSchema.parse(await sources.json()).total).toBe(0);
		expect(AlertListSchema.parse(await alerts.json()).total).toBe(0);
		const sameName = await system.app.request(
			"/v1/alert-sources",
			authed(globexAdmin, { name: "prometheus" }),
		);
		expect(sameName.status).toBe(201);
	});

	it("files an alert under its source's tenant only, even for a shared dedup key", async () => {
		const acme = await addAlertSource(system.app, "acme-admin");
		const globex = await addAlertSource(system.app, globexAdmin);
		await system.app.request(`/webhooks/alerts/${acme.sourceId}`, signedAlert(acme.secret, alert));
		await system.app.request(
			`/webhooks/alerts/${globex.sourceId}`,
			signedAlert(globex.secret, alert),
		);

		await system.processor.processMessages();

		expect((await incidentsOf("acme-admin")).items).toMatchObject([{ alertCount: 1 }]);
		expect((await incidentsOf(globexAdmin)).items).toMatchObject([{ alertCount: 1 }]);
	});

	it("groups nothing for a queue message that pairs an alert with another tenant", async () => {
		const acme = await addAlertSource(system.app, "acme-admin");
		const res = await system.app.request(
			`/webhooks/alerts/${acme.sourceId}`,
			signedAlert(acme.secret, alert),
		);
		const { alertId } = AlertAcceptedSchema.parse(await res.json());
		// Whoever can send to the queue names only ids. A mismatched pair finds no row.
		await system.queue.send({ tenantId: randomUUID() as TenantId, alertId });

		await system.processor.processMessages();

		expect((await incidentsOf("acme-admin")).items).toMatchObject([{ alertCount: 1 }]);
		expect((await incidentsOf(globexAdmin)).total).toBe(0);
		expect(system.queue.size).toBe(0);
	});

	it("refuses one tenant's secret on another tenant's source", async () => {
		const acme = await addAlertSource(system.app, "acme-admin");
		const globex = await addAlertSource(system.app, globexAdmin);

		const res = await system.app.request(
			`/webhooks/alerts/${globex.sourceId}`,
			signedAlert(acme.secret, alert),
		);

		expect(res.status).toBe(401);
		expect(await system.processor.processMessages()).toBe(0);
	});

	it("rejects a tenantId in the alert body, and files nothing", async () => {
		const { sourceId, secret } = await addAlertSource(system.app, "acme-admin");

		const res = await system.app.request(
			`/webhooks/alerts/${sourceId}`,
			signedAlert(secret, { ...alert, tenantId: "tenant-globex" }),
		);

		expect(res.status).toBe(422);
		expect(await system.processor.processMessages()).toBe(0);
	});

	it("ignores a bearer token on the webhook: only the signature counts", async () => {
		const { sourceId } = await addAlertSource(system.app, "acme-admin");

		const res = await system.app.request(
			`/webhooks/alerts/${sourceId}`,
			authed("acme-admin", alert),
		);

		expect(res.status).toBe(401);
	});

	it("refuses viewers and responders on sources and alerts", async () => {
		for (const token of ["acme-viewer", "acme-responder"]) {
			const created = await system.app.request("/v1/alert-sources", authed(token, { name: "x" }));
			const listed = await system.app.request("/v1/alerts", authed(token));
			expect([created.status, listed.status]).toEqual([403, 403]);
		}
		const list = await system.app.request("/v1/alert-sources", authed("acme-admin"));
		expect(AlertSourceListSchema.parse(await list.json()).total).toBe(0);
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

describe("audit log", () => {
	let system: ReturnType<typeof buildTestSystem>;

	beforeEach(() => {
		system = buildTestSystem();
	});

	const log = async (token: string) => {
		const res = await system.app.request("/v1/audit-events?limit=100", authed(token));
		expect(res.status).toBe(200);
		return res.text();
	};

	it("shows each tenant only its own events, and hides another tenant's incident timeline", async () => {
		const globexAdmin = await signup(system.app, "admin@globex.example", "Globex");
		const res = await system.app.request(
			"/v1/incidents",
			authed("acme-responder", { title: "Checkout is down", severity: "sev1" }),
		);
		const { id } = IncidentSchema.parse(await res.json());

		const globexLog = AuditEventListSchema.parse(JSON.parse(await log(globexAdmin)));
		const timeline = await system.app.request(`/v1/incidents/${id}/events`, authed(globexAdmin));

		expect(globexLog.items.map((event) => event.action)).toEqual(["tenant.created"]);
		expect(JSON.stringify(globexLog)).not.toContain(id);
		expect(timeline.status).toBe(404);
	});

	it("never filters its way into another tenant's events", async () => {
		const globexAdmin = await signup(system.app, "admin@globex.example", "Globex");
		await system.app.request(
			"/v1/incidents",
			authed("acme-responder", { title: "Checkout is down", severity: "sev1" }),
		);

		const res = await system.app.request(
			"/v1/audit-events?actorId=user-1&action=incident.created",
			authed(globexAdmin),
		);

		expect(AuditEventListSchema.parse(await res.json()).total).toBe(0);
	});

	it("never carries a secret, token, webhook URL, password or email, to any role", async () => {
		const ownerToken = await signup(system.app, "owner@initech.example", "Initech");
		const { secret } = await addAlertSource(system.app, ownerToken);
		const webhookUrl = "https://hooks.slack.com/services/T000/B000/abcdWXYZ";
		await system.app.request(
			"/v1/notification-channels",
			authed(ownerToken, { name: "#ops", webhookUrl }),
		);
		const invite = await system.app.request(
			"/v1/members",
			authed(ownerToken, { email: "milton@initech.example", role: "viewer" }),
		);
		const { setupToken } = (await invite.json()) as { setupToken: string };
		await system.app.request(
			"/v1/auth/setup-password",
			post({ token: setupToken, password: "stapler stapler stapler" }),
		);
		await system.app.request(
			"/v1/auth/login",
			post({ email: "milton@initech.example", password: "a guessed password" }),
		);
		const login = await system.app.request(
			"/v1/auth/login",
			post({ email: "milton@initech.example", password: "stapler stapler stapler" }),
		);
		const { accessToken: viewerToken } = (await login.json()) as { accessToken: string };

		for (const token of [ownerToken, viewerToken]) {
			const text = await log(token);
			AuditEventListSchema.parse(JSON.parse(text));
			for (const leaked of [
				secret,
				webhookUrl,
				"hooks.slack.com",
				setupToken,
				"stapler",
				"a guessed password",
				"owner@initech.example",
				"milton@initech.example",
				ownerToken,
			]) {
				expect(text).not.toContain(leaked);
			}
		}
	});
});

describe("member management changes", () => {
	let app: ReturnType<typeof buildTestApp>;

	beforeEach(() => {
		app = buildTestApp();
	});

	const send = (method: string, path: string, token: string, body?: unknown) =>
		app.request(path, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

	const inviteTo = async (adminToken: string, email: string, role: string) =>
		MemberInviteSchema.parse(
			await (await app.request("/v1/members", authed(adminToken, { email, role }))).json(),
		);

	it.each(["viewer", "responder"])(
		"forbids a %s from changing or removing members",
		async (role) => {
			const admin = await signup(app, "ada@acme.example", "Acme");
			const target = await inviteTo(admin, "grace@acme.example", "viewer");
			const member = await inviteTo(admin, `${role}@acme.example`, role);
			const login = await app.request(
				"/v1/auth/setup-password",
				post({ token: member.setupToken, password: "correct horse battery" }),
			);
			const token = AccessTokenSchema.parse(await login.json()).accessToken;

			const statuses = await Promise.all([
				send("PATCH", `/v1/members/${target.id}`, token, { role: "admin" }),
				send("DELETE", `/v1/members/${target.id}`, token),
				send("PATCH", "/v1/members", token, { changes: [{ id: target.id, role: "admin" }] }),
				send("POST", "/v1/members/remove", token, { ids: [target.id] }),
			]);

			expect(statuses.map((res) => res.status)).toEqual([403, 403, 403, 403]);
			const members = MemberListSchema.parse(
				await (await app.request("/v1/members", authed(admin))).json(),
			);
			expect(members.items.find((m) => m.id === target.id)?.role).toBe("viewer");
		},
	);

	it("hides another tenant's member, alone or inside a bulk request", async () => {
		const acme = await signup(app, "ada@acme.example", "Acme");
		const globex = await signup(app, "hank@globex.example", "Globex");
		const target = await inviteTo(acme, "grace@acme.example", "viewer");
		const own = await inviteTo(globex, "frank@globex.example", "viewer");

		const results = await Promise.all([
			send("PATCH", `/v1/members/${target.id}`, globex, { role: "admin" }),
			send("DELETE", `/v1/members/${target.id}`, globex),
			send("PATCH", "/v1/members", globex, {
				changes: [
					{ id: own.id, role: "responder" },
					{ id: target.id, role: "admin" },
				],
			}),
			send("POST", "/v1/members/remove", globex, { ids: [own.id, target.id] }),
		]);

		expect(results.map((res) => res.status)).toEqual([404, 404, 404, 404]);
		const acmeMembers = MemberListSchema.parse(
			await (await app.request("/v1/members", authed(acme))).json(),
		);
		expect(acmeMembers.items.find((m) => m.id === target.id)?.role).toBe("viewer");
		// All or nothing: globex's own member was not changed or removed either.
		const globexMembers = MemberListSchema.parse(
			await (await app.request("/v1/members", authed(globex))).json(),
		);
		expect(globexMembers.items.find((m) => m.id === own.id)?.role).toBe("viewer");
	});
});
