import { randomUUID } from "node:crypto";
import { sign } from "hono/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import { createAesGcmSecretBox } from "../src/adapters/aesGcmSecretBox";
import {
	AlertAcceptedSchema,
	AlertListSchema,
	AlertSourceListSchema,
} from "../src/contract/alerts";
import { AuditEventListSchema } from "../src/contract/audit";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { DashboardSchema } from "../src/contract/dashboard";
import { IncidentListSchema, IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema, MemberListSchema } from "../src/contract/members";
import {
	NotificationChannelListSchema,
	NotificationChannelSchema,
} from "../src/contract/notificationChannels";
import {
	OnCallOverrideSchema,
	OnCallScheduleListSchema,
	OnCallScheduleSchema,
} from "../src/contract/onCall";
import { channelSecretContext } from "../src/domain/notifications/types";
import type { TenantId } from "../src/domain/shared/identity";
import { anAudit } from "./auditEntries";
import {
	addAlertSource,
	authed,
	buildTestApp,
	buildTestSystem,
	post,
	signedAlert,
	signup,
	TEST_ENCRYPTION_KEY,
	TEST_JWT_SECRET,
} from "./helpers";
import { openStream } from "./sse";

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
		await app.request(
			"/v1/members",
			authed(admin, { email: "grace@example.com", role: "responder" }),
		);

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

	// Spec: docs/features/on-call-schedules.md. Every member sees their own tenant's members.
	it("lets a responder list their own tenant's members, but not add one", async () => {
		const member = await activate(
			(await invite(admin, "grace@example.com", "responder")).setupToken,
		);
		const globex = await signup(app, "linus@example.com", "Globex");
		await invite(globex, "frank@example.com", "responder");

		const listed = await app.request("/v1/members", authed(member));
		const add = await app.request(
			"/v1/members",
			authed(member, { email: "x@example.com", role: "admin" }),
		);

		expect(listed.status).toBe(200);
		expect(
			MemberListSchema.parse(await listed.json())
				.items.map((m) => m.email)
				.sort(),
		).toEqual(["ada@example.com", "grace@example.com"]);
		expect(add.status).toBe(403);
	});

	it("keeps each tenant's members separate", async () => {
		const globex = await signup(app, "linus@example.com", "Globex");
		await invite(globex, "grace@example.com", "responder");

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
		await activate((await invite(admin, "grace@example.com", "responder")).setupToken);

		const body = await (await app.request("/v1/members", authed(admin))).text();

		expect(body).not.toMatch(/argon2|password/i);
	});

	it("accepts a setup token only once", async () => {
		const { setupToken } = await invite(admin, "grace@example.com", "responder");
		await activate(setupToken);

		const again = await app.request(
			"/v1/auth/setup-password",
			post({ token: setupToken, password: PASSWORD }),
		);

		expect(again.status).toBe(401);
	});

	it("lets exactly one of two simultaneous setup-token uses win", async () => {
		const { setupToken } = await invite(admin, "grace@example.com", "responder");

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

	it("refuses responders, even with a valid body", async () => {
		for (const token of ["acme-responder-2", "acme-responder"]) {
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

	it("refuses responders on sources and alerts", async () => {
		for (const token of ["acme-responder-2", "acme-responder"]) {
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

		// A fresh UUID. Not "does not contain bad": b, a and d are hex digits, so a random UUID
		// contains "bad" about once in 125 runs.
		const id = res.headers.get("X-Request-ID");
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(id).not.toBe("bad id\twith spaces");
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
			authed(ownerToken, { email: "milton@initech.example", role: "responder" }),
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
		const { accessToken: memberToken } = (await login.json()) as { accessToken: string };

		for (const token of [ownerToken, memberToken]) {
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

	it.each(["responder"])("forbids a %s from changing or removing members", async (role) => {
		const admin = await signup(app, "ada@acme.example", "Acme");
		const target = await inviteTo(admin, "grace@acme.example", "responder");
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
		expect(members.items.find((m) => m.id === target.id)?.role).toBe("responder");
	});

	it("hides another tenant's member, alone or inside a bulk request", async () => {
		const acme = await signup(app, "ada@acme.example", "Acme");
		const globex = await signup(app, "hank@globex.example", "Globex");
		const target = await inviteTo(acme, "grace@acme.example", "responder");
		const own = await inviteTo(globex, "frank@globex.example", "responder");

		const results = await Promise.all([
			send("PATCH", `/v1/members/${target.id}`, globex, { role: "admin" }),
			send("DELETE", `/v1/members/${target.id}`, globex),
			send("PATCH", "/v1/members", globex, {
				changes: [
					{ id: own.id, role: "admin" },
					{ id: target.id, role: "admin" },
				],
			}),
			send("POST", "/v1/members/remove", globex, { ids: [own.id, target.id] }),
		]);

		expect(results.map((res) => res.status)).toEqual([404, 404, 404, 404]);
		const acmeMembers = MemberListSchema.parse(
			await (await app.request("/v1/members", authed(acme))).json(),
		);
		expect(acmeMembers.items.find((m) => m.id === target.id)?.role).toBe("responder");
		// All or nothing: globex's own member was not changed or removed either.
		const globexMembers = MemberListSchema.parse(
			await (await app.request("/v1/members", authed(globex))).json(),
		);
		expect(globexMembers.items.find((m) => m.id === own.id)?.role).toBe("responder");
	});
});

// Spec: docs/features/slack-delivery.md
describe("slack delivery", () => {
	const SECRET_URL = "https://hooks.slack.com/services/T000/B000/s3cretTokenPart";
	let system: ReturnType<typeof buildTestSystem>;
	let acme: string;

	beforeEach(async () => {
		system = buildTestSystem();
		acme = await signup(system.app, "ada@acme.example", "Acme");
	});

	const addChannel = async (token: string, webhookUrl = SECRET_URL) => {
		const res = await system.app.request(
			"/v1/notification-channels",
			authed(token, { name: "#incidents", webhookUrl }),
		);
		return NotificationChannelSchema.parse(await res.json()).id;
	};

	const work = async () => {
		while ((await system.deliveryProcessor.processMessages()) > 0) {
			// Until the queue is empty.
		}
	};

	it("refuses an internal or non-allowlisted webhook at channel creation", async () => {
		for (const webhookUrl of [
			"http://169.254.169.254/latest/meta-data/iam",
			"http://localhost:5432",
			"https://hooks.slack.com@evil.example/x",
			"file:///etc/passwd",
		]) {
			const res = await system.app.request(
				"/v1/notification-channels",
				authed(acme, { name: "#x", webhookUrl }),
			);
			expect(res.status).toBe(422);
		}
	});

	it("refuses a stored channel outside the allowlist at send time, without calling it", async () => {
		// Created before the allowlist existed, as the old API allowed: stored directly.
		const tenantId = (await system.accounts.findUserByEmail("ada@acme.example"))?.tenantId;
		if (!tenantId) throw new Error("no tenant");
		const id = randomUUID();
		await system.channels.create(
			tenantId,
			{
				id,
				kind: "slack_webhook",
				name: "#legacy",
				targetCiphertext: createAesGcmSecretBox(TEST_ENCRYPTION_KEY).seal(
					"http://169.254.169.254/latest/meta-data/iam",
					channelSecretContext(tenantId, id),
				),
				targetHint: "/iam",
				minSeverity: "sev4",
				enabled: true,
				createdAt: new Date(),
			},
			anAudit(tenantId, "notification_channel.created"),
		);

		await system.app.request("/v1/incidents", authed(acme, validBody));
		await work();

		expect(system.sender.posts).toEqual([]);
		expect(system.deliveries.allSync()).toMatchObject([
			{ state: "failed", failureReason: "host_not_allowed" },
		]);
	});

	it("keeps the webhook URL out of queue messages, delivery rows, responses and error reports", async () => {
		const channel = await addChannel(acme);
		await system.app.request("/v1/incidents", authed(acme, validBody));
		const queued = [...system.notificationQueue.bodies];
		system.sender.answers = [{ kind: "error", error: "network error" }];
		await work();
		const listed = await system.app.request(
			`/v1/notification-channels/${channel}/deliveries`,
			authed(acme),
		);

		expect(queued).toHaveLength(1);
		for (const text of [
			...queued,
			JSON.stringify(system.deliveries.allSync()),
			await listed.text(),
			...system.deliveryErrors.map((e) => `${e.subject} ${String(e.error)}`),
		]) {
			expect(text).not.toContain("s3cretTokenPart");
			expect(text).not.toContain("hooks.slack.com");
		}
		// The queue carries the two ids and nothing else.
		expect(Object.keys(JSON.parse(queued[0] ?? "{}")).sort()).toEqual(["deliveryId", "tenantId"]);
	});

	it("never returns the payload or the actor's email in the delivery history", async () => {
		const channel = await addChannel(acme);
		await system.app.request("/v1/incidents", authed(acme, validBody));

		const listed = await system.app.request(
			`/v1/notification-channels/${channel}/deliveries`,
			authed(acme),
		);

		const body = await listed.text();
		expect(body).not.toContain("ada@acme.example");
		expect(body).not.toContain("Checkout is down");
		expect(body).not.toContain("payload");
	});

	it("does not let a title mention the channel or post a link", async () => {
		await addChannel(acme);
		await system.app.request(
			"/v1/incidents",
			authed(acme, { title: "<!channel> pay <https://evil.example|here>", severity: "sev1" }),
		);
		await work();

		const [text] = system.sender.texts;
		expect(text).toContain("&lt;!channel&gt; pay &lt;https://evil.example|here&gt;");
		expect(text).not.toMatch(/<!channel>|<https?:/);
	});

	it("returns 404 for another tenant's channel history", async () => {
		const channel = await addChannel(acme);
		const globex = await signup(system.app, "admin@globex.example", "Globex");

		const res = await system.app.request(
			`/v1/notification-channels/${channel}/deliveries`,
			authed(globex),
		);

		expect(res.status).toBe(404);
	});

	it("does not post another tenant's delivery from a forged queue message", async () => {
		await addChannel(acme);
		await system.app.request("/v1/incidents", authed(acme, validBody));
		await work();
		const [delivery] = system.deliveries.allSync();
		const globex = await signup(system.app, "admin@globex.example", "Globex");
		const globexTenant = (await system.accounts.findUserByEmail("admin@globex.example"))?.tenantId;
		expect(globex).toBeTruthy();

		system.notificationQueue.sendRaw(
			JSON.stringify({ tenantId: globexTenant, deliveryId: delivery?.id }),
		);
		await work();

		expect(system.sender.posts).toHaveLength(1);
	});

	it("does not post to another tenant's channel", async () => {
		await addChannel(acme);
		const globex = await signup(system.app, "admin@globex.example", "Globex");

		await system.app.request("/v1/incidents", authed(globex, validBody));
		await work();

		expect(system.sender.posts).toEqual([]);
	});
});

// Spec: docs/features/on-call-schedules.md
describe("on-call", () => {
	let app: ReturnType<typeof buildTestApp>;
	let acme: string;
	let globex: string;
	let grace: { id: string; token: string };
	let frank: { id: string; token: string };
	let scheduleId: string;

	const send = (method: string, path: string, token: string, body?: unknown) =>
		app.request(path, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

	const join = async (adminToken: string, email: string) => {
		const invited = await app.request(
			"/v1/members",
			authed(adminToken, { email, role: "responder" }),
		);
		const member = MemberInviteSchema.parse(await invited.json());
		const res = await app.request(
			"/v1/auth/setup-password",
			post({ token: member.setupToken, password: PASSWORD }),
		);
		return { id: member.id, token: AccessTokenSchema.parse(await res.json()).accessToken };
	};

	const schedule = (participants: string[]) => ({
		name: "Payments",
		timeZone: "UTC",
		handoffTime: "00:00",
		rotationDays: 7,
		startsOn: "2020-01-06",
		participants,
		isDefault: true,
	});

	const cover = (userId: string) => ({
		userId,
		startsAt: new Date(Date.now() + 60_000).toISOString(),
		endsAt: new Date(Date.now() + 3_600_000).toISOString(),
	});

	beforeEach(async () => {
		app = buildTestApp();
		acme = await signup(app, "ada@acme.example", "Acme");
		globex = await signup(app, "hank@globex.example", "Globex");
		grace = await join(acme, "grace@acme.example");
		frank = await join(globex, "frank@globex.example");
		const res = await send("POST", "/v1/on-call-schedules", acme, schedule([grace.id]));
		scheduleId = OnCallScheduleSchema.parse(await res.json()).id;
	});

	it("hides a schedule, its on-call answer and its overrides from another tenant", async () => {
		const path = `/v1/on-call-schedules/${scheduleId}`;

		const statuses = await Promise.all([
			send("GET", path, globex),
			send("PATCH", path, globex, { name: "Mine" }),
			send("DELETE", path, globex),
			send("GET", `${path}/on-call`, globex),
			send("GET", `${path}/overrides`, globex),
			send("POST", `${path}/overrides`, globex, cover(frank.id)),
		]);

		expect(statuses.map((res) => res.status)).toEqual([404, 404, 404, 404, 404, 404]);
		const list = await send("GET", "/v1/on-call-schedules", globex);
		expect(OnCallScheduleListSchema.parse(await list.json()).total).toBe(0);
		expect((await send("GET", path, acme)).status).toBe(200);
	});

	it("never puts another tenant's member in a rotation, an override or an incident", async () => {
		const path = `/v1/on-call-schedules/${scheduleId}`;
		const incident = IncidentSchema.parse(
			await (await send("POST", "/v1/incidents", acme, validBody)).json(),
		);

		const results = await Promise.all([
			send("POST", "/v1/on-call-schedules", acme, { ...schedule([frank.id]), name: "Other" }),
			send("PATCH", path, acme, { participants: [grace.id, frank.id] }),
			send("POST", `${path}/overrides`, acme, cover(frank.id)),
			send("POST", `/v1/incidents/${incident.id}/assign`, acme, { assigneeId: frank.id }),
		]);

		expect(results.map((res) => res.status)).toEqual([404, 404, 404, 404]);
		const read = await send("GET", path, acme);
		expect(OnCallScheduleSchema.parse(await read.json()).participants).toEqual([
			{ userId: grace.id, email: "grace@acme.example" },
		]);
	});

	it("never assigns an incident from another tenant's schedule", async () => {
		const incident = IncidentSchema.parse(
			await (await send("POST", "/v1/incidents", globex, validBody)).json(),
		);

		expect(incident.assignee).toBeNull();
	});

	it("refuses to link an alert source to another tenant's schedule", async () => {
		const { sourceId } = await addAlertSource(app, globex);

		const patched = await send("PATCH", `/v1/alert-sources/${sourceId}`, globex, {
			onCallScheduleId: scheduleId,
		});
		const created = await send("POST", "/v1/alert-sources", globex, {
			name: "grafana",
			onCallScheduleId: scheduleId,
		});
		const foreignSource = await send("PATCH", `/v1/alert-sources/${sourceId}`, acme, {
			onCallScheduleId: scheduleId,
		});

		expect([patched.status, created.status, foreignSource.status]).toEqual([404, 404, 404]);
	});

	it("lets a responder manage only their own overrides, and no schedule", async () => {
		const alan = await join(acme, "alan@acme.example");
		const path = `/v1/on-call-schedules/${scheduleId}/overrides`;
		const own = await send("POST", path, alan.token, cover(alan.id));
		const ownId = OnCallOverrideSchema.parse(await own.json()).id;
		const graces = await send("POST", path, acme, {
			...cover(grace.id),
			startsAt: new Date(Date.now() + 7_200_000).toISOString(),
			endsAt: new Date(Date.now() + 9_000_000).toISOString(),
		});
		const gracesId = OnCallOverrideSchema.parse(await graces.json()).id;

		const results = await Promise.all([
			send("POST", path, alan.token, {
				...cover(grace.id),
				startsAt: new Date(Date.now() + 10_000_000).toISOString(),
				endsAt: new Date(Date.now() + 11_000_000).toISOString(),
			}),
			send("DELETE", `${path}/${gracesId}`, alan.token),
			send("POST", "/v1/on-call-schedules", alan.token, { ...schedule([]), name: "Mine" }),
			send("PATCH", `/v1/on-call-schedules/${scheduleId}`, alan.token, { isDefault: false }),
			send("DELETE", `/v1/on-call-schedules/${scheduleId}`, alan.token),
		]);

		expect(own.status).toBe(201);
		expect(results.map((res) => res.status)).toEqual([403, 403, 403, 403, 403]);
		expect((await send("DELETE", `${path}/${ownId}`, alan.token)).status).toBe(204);
	});

	it("lets only the assignee or an admin act on an assigned incident, and audits a takeover", async () => {
		const alan = await join(acme, "alan@acme.example");
		const incident = IncidentSchema.parse(
			await (await send("POST", "/v1/incidents", acme, validBody)).json(),
		);
		expect(incident.assignee?.id).toBe(grace.id);

		const refused = await send("POST", `/v1/incidents/${incident.id}/acknowledge`, alan.token, {});
		const unassign = await send("POST", `/v1/incidents/${incident.id}/assign`, alan.token, {
			assigneeId: null,
		});
		await send("POST", `/v1/incidents/${incident.id}/assign`, alan.token, { assigneeId: alan.id });
		const taken = await send("POST", `/v1/incidents/${incident.id}/acknowledge`, alan.token, {});

		expect([refused.status, unassign.status, taken.status]).toEqual([403, 403, 200]);
		const timeline = AuditEventListSchema.parse(
			await (await send("GET", `/v1/incidents/${incident.id}/events`, acme)).json(),
		);
		expect(timeline.items.map((event) => [event.action, event.actor.id])).toEqual([
			["incident.created", expect.any(String)],
			["incident.assigned", expect.any(String)],
			["incident.assigned", alan.id],
			["incident.acknowledged", alan.id],
		]);
		expect(JSON.stringify(timeline)).not.toMatch(/@acme\.example/);
	});
});

// Spec: docs/features/dashboard-stats.md
describe("dashboard", () => {
	it("never counts or names another tenant's incidents or assignees", async () => {
		const app = buildTestApp();
		const acme = await signup(app, "ada@acme.example", "Acme");
		const globex = await signup(app, "hank@globex.example", "Globex");
		const invited = await app.request(
			"/v1/members",
			authed(globex, { email: "frank@globex.example", role: "responder" }),
		);
		const frank = MemberInviteSchema.parse(await invited.json());
		for (const severity of ["sev1", "sev2"]) {
			const res = await app.request("/v1/incidents", authed(globex, { ...validBody, severity }));
			const { id } = IncidentSchema.parse(await res.json());
			await app.request(`/v1/incidents/${id}/assign`, authed(globex, { assigneeId: frank.id }));
		}
		await app.request("/v1/incidents", authed(acme, validBody));

		const acmeView = DashboardSchema.parse(
			await (await app.request("/v1/dashboard", authed(acme))).json(),
		);
		const globexView = DashboardSchema.parse(
			await (await app.request("/v1/dashboard", authed(globex))).json(),
		);

		expect(acmeView.totals).toEqual({ open: 1, acknowledged: 0, unassigned: 1 });
		expect(acmeView.load).toEqual([]);
		expect(JSON.stringify(acmeView)).not.toContain("globex");
		expect(globexView.totals).toEqual({ open: 2, acknowledged: 0, unassigned: 0 });
		expect(globexView.load.map((row) => row.email)).toEqual(["frank@globex.example"]);
	});

	it("ignores a tenant smuggled in the query", async () => {
		const app = buildTestApp();
		await app.request("/v1/incidents", authed("globex-responder", validBody));

		const res = await app.request("/v1/dashboard?tenantId=tenant-globex", authed("acme-responder"));

		expect(DashboardSchema.parse(await res.json()).totals.open).toBe(0);
	});
});

// Spec: docs/features/realtime-status.md
describe("realtime", () => {
	it("never sends a stream another tenant's changes", async () => {
		const system = buildTestSystem();
		const acme = await signup(system.app, "ada@acme.example", "Acme");
		const globex = await signup(system.app, "hank@globex.example", "Globex");
		const stream = await openStream(system.app, acme);
		await stream.next();

		const foreign = IncidentSchema.parse(
			await (await system.app.request("/v1/incidents", authed(globex, validBody))).json(),
		);
		await system.app.request(
			"/v1/on-call-schedules",
			authed(globex, {
				name: "Globex",
				timeZone: "UTC",
				handoffTime: "09:00",
				rotationDays: 7,
				startsOn: "2026-01-05",
			}),
		);
		const own = IncidentSchema.parse(
			await (await system.app.request("/v1/incidents", authed(acme, validBody))).json(),
		);
		// Events keep order, so everything before acme's own incident has arrived by then.
		const events = await stream.until("dashboard");

		expect(events.map((event) => event.event)).toEqual(["incident.opened", "dashboard"]);
		expect(events[0]?.data).toMatchObject({ incident: { id: own.id } });
		expect(JSON.stringify(events)).not.toContain(foreign.id);
		expect(JSON.stringify(events)).not.toContain("globex");
		await stream.close();
	});

	it("accepts a token only in the Authorization header", async () => {
		const app = buildTestApp();
		const token = await signup(app, "ada@acme.example", "Acme");

		const res = await app.request(`/v1/events?token=${token}&access_token=${token}`);

		expect(res.status).toBe(401);
	});
});

// Spec: docs/features/login-rate-limiting.md
describe("login rate limiting", () => {
	it("answers a locked known email, unknown email and address identically", async () => {
		const system = buildTestSystem({ trustedProxyHops: 1 });
		await signup(system.app, "ada@acme.example", "Acme");
		const login = (email: string, ip: string) =>
			system.app.request("/v1/auth/login", {
				...post({ email, password: "a wrong password" }),
				headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
			});
		for (let n = 0; n < 5; n++) {
			await login("ada@acme.example", `203.0.113.${n}`);
			await login("nobody@acme.example", `203.0.113.${n}`);
		}
		for (let n = 0; n < 30; n++) await login(`spray${n}@acme.example`, "198.51.100.9");

		const answers = await Promise.all([
			login("ada@acme.example", "203.0.113.200"),
			login("nobody@acme.example", "203.0.113.200"),
			login("fresh@acme.example", "198.51.100.9"),
		]);

		const bodies = await Promise.all(
			answers.map(async (res) => {
				expect(res.status).toBe(429);
				const { requestId: _ignored, ...rest } = ProblemSchema.parse(await res.json());
				return { ...rest, retryAfter: res.headers.get("Retry-After") };
			}),
		);
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[2]).toEqual(bodies[0]);
	});

	it("does not let a client escape the address limit by writing its own X-Forwarded-For", async () => {
		// One trusted proxy, which appends the real address 198.51.100.9 to whatever the client sent.
		const system = buildTestSystem({ trustedProxyHops: 1 });
		const attempt = (n: number) =>
			system.app.request("/v1/auth/login", {
				...post({ email: `spray${n}@acme.example`, password: "a wrong password" }),
				headers: {
					"Content-Type": "application/json",
					"X-Forwarded-For": `10.${n}.0.1, 198.51.100.9`,
				},
			});

		const statuses = [];
		for (let n = 0; n < 31; n++) statuses.push((await attempt(n)).status);

		expect(statuses.slice(0, 30).every((status) => status === 401)).toBe(true);
		expect(statuses[30]).toBe(429);
	});

	it("ignores X-Forwarded-For entirely when no proxy is trusted", async () => {
		const system = buildTestSystem();
		for (let n = 0; n < 30; n++) {
			await system.app.request("/v1/auth/login", {
				...post({ email: `spray${n}@acme.example`, password: "a wrong password" }),
				headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.${n}.0.1` },
			});
		}

		const res = await system.app.request("/v1/auth/login", {
			...post({ email: "another@acme.example", password: "a wrong password" }),
			headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.99.0.1" },
		});

		expect(res.status).toBe(429);
	});
});

// Spec: docs/features/ai-summaries.md
describe("ai summaries", () => {
	it("never lets another tenant read, request or accept an incident's drafts, or set its summary", async () => {
		const system = buildTestSystem();
		const acme = await signup(system.app, "ada@acme.example", "Acme");
		const globex = await signup(system.app, "hank@globex.example", "Globex");
		const incident = IncidentSchema.parse(
			await (await system.app.request("/v1/incidents", authed(acme, validBody))).json(),
		);
		await system.summaryProcessor.process();
		const globexIncident = IncidentSchema.parse(
			await (await system.app.request("/v1/incidents", authed(globex, validBody))).json(),
		);
		const path = `/v1/incidents/${incident.id}`;
		const acmeDrafts = (await (
			await system.app.request(`${path}/summary-drafts`, authed(acme))
		).json()) as { items: { id: string }[] };
		const put = (token: string, incidentId: string, body: unknown) =>
			system.app.request(`/v1/incidents/${incidentId}/summary`, {
				...authed(token, body),
				method: "PUT",
			});

		const statuses = await Promise.all([
			system.app.request(`${path}/summary-drafts`, authed(globex)),
			system.app.request(`${path}/summary-drafts`, authed(globex, {})),
			put(globex, incident.id, { text: "Hijacked" }),
			// Globex's own incident, but Acme's draft id.
			put(globex, globexIncident.id, { text: "Copied", draftId: acmeDrafts.items[0]?.id }),
		]);

		expect(statuses.map((res) => res.status)).toEqual([404, 404, 404, 404]);
		const after = IncidentSchema.parse(await (await system.app.request(path, authed(acme))).json());
		expect(after.summary).toBeNull();
	});

	it("sends the model nothing from another tenant, and no emails, tokens or ids", async () => {
		const system = buildTestSystem();
		const acme = await signup(system.app, "ada@acme.example", "Acme");
		const globex = await signup(system.app, "hank@globex.example", "Globex");
		const { sourceId, secret } = await addAlertSource(system.app, acme);
		await system.app.request(
			`/webhooks/alerts/${sourceId}`,
			signedAlert(secret, {
				dedupKey: "checkout",
				title: "Checkout down for grace@acme.example",
				severity: "sev1",
				details: { api_key: "live-key-123", owner: "ops@acme.example" },
			}),
		);
		await system.processor.processMessages();
		await system.app.request(
			"/v1/incidents",
			authed(globex, { title: "Globex billing is down", severity: "sev1" }),
		);

		await system.summaryProcessor.process();

		const sent = JSON.stringify(system.writer.prompts);
		expect(system.writer.prompts).toHaveLength(2);
		const acmePrompt = system.writer.prompts.find((prompt) => prompt.user.includes("Checkout"));
		expect(acmePrompt?.user).not.toContain("Globex");
		for (const leaked of [
			"grace@acme.example",
			"ops@acme.example",
			"ada@acme.example",
			"live-key-123",
			sourceId,
			secret,
		]) {
			expect(sent).not.toContain(leaked);
		}
	});
});

// Spec: docs/features/ai-postmortems.md
describe("ai postmortems", () => {
	it("never lets another tenant read, draft, save or publish an incident's postmortem", async () => {
		const system = buildTestSystem();
		const acme = await signup(system.app, "ada@acme.example", "Acme");
		const globex = await signup(system.app, "hank@globex.example", "Globex");
		const incident = IncidentSchema.parse(
			await (await system.app.request("/v1/incidents", authed(acme, validBody))).json(),
		);
		await system.app.request(`/v1/incidents/${incident.id}/resolve`, authed(acme, {}));
		await system.postmortemProcessor.process();
		const path = `/v1/incidents/${incident.id}`;
		await system.app.request(`${path}/postmortem`, {
			...authed(acme, { body: "Acme's private postmortem." }),
			method: "PUT",
		});

		const statuses = await Promise.all([
			system.app.request(`${path}/postmortem`, authed(globex)),
			system.app.request(`${path}/postmortem-drafts`, authed(globex)),
			system.app.request(`${path}/postmortem-drafts`, authed(globex, {})),
			system.app.request(`${path}/postmortem`, {
				...authed(globex, { body: "Overwritten" }),
				method: "PUT",
			}),
			system.app.request(`${path}/postmortem/publish`, authed(globex, {})),
		]);

		expect(statuses.map((res) => res.status)).toEqual([404, 404, 404, 404, 404]);
		const after = (await (await system.app.request(`${path}/postmortem`, authed(acme))).json()) as {
			body: string;
			state: string;
		};
		expect(after).toMatchObject({ body: "Acme's private postmortem.", state: "draft" });
	});

	it("sends the model no names, emails or ids from the timeline, and nothing from another tenant", async () => {
		const system = buildTestSystem();
		const acme = await signup(system.app, "ada@acme.example", "Acme");
		const globex = await signup(system.app, "hank@globex.example", "Globex");
		const acmeIncident = IncidentSchema.parse(
			await (
				await system.app.request(
					"/v1/incidents",
					authed(acme, { title: "Checkout down, ask ada@acme.example", severity: "sev1" }),
				)
			).json(),
		);
		await system.app.request(`/v1/incidents/${acmeIncident.id}/acknowledge`, authed(acme, {}));
		await system.app.request(`/v1/incidents/${acmeIncident.id}/resolve`, authed(acme, {}));
		const globexIncident = IncidentSchema.parse(
			await (
				await system.app.request(
					"/v1/incidents",
					authed(globex, { title: "Globex billing down", severity: "sev2" }),
				)
			).json(),
		);
		await system.app.request(`/v1/incidents/${globexIncident.id}/resolve`, authed(globex, {}));
		const acmeUser = (await system.accounts.findUserByEmail("ada@acme.example"))?.id ?? "missing";

		await system.postmortemProcessor.process();

		const postmortemPrompts = system.writer.prompts.filter(
			(prompt) => prompt.schema.name === "incident_postmortem",
		);
		expect(postmortemPrompts).toHaveLength(2);
		const acmePrompt = postmortemPrompts.find((prompt) => prompt.user.includes("Checkout"));
		expect(acmePrompt?.user).toContain('"action": "acknowledged"');
		expect(acmePrompt?.user).not.toContain("Globex");
		const sent = JSON.stringify(postmortemPrompts);
		for (const leaked of ["ada@acme.example", "hank@globex.example", acmeUser, acmeIncident.id]) {
			expect(sent).not.toContain(leaked);
		}
	});
});
