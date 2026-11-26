import { beforeEach, describe, expect, it } from "vitest";
import { AlertAcceptedSchema } from "../src/contract/alerts";
import { AuditEventListSchema, type AuditEventResponse } from "../src/contract/audit";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema, MemberListSchema } from "../src/contract/members";
import type { TenantId } from "../src/domain/shared/identity";
import { addAlertSource, authed, buildTestSystem, post, signedAlert, signup } from "./helpers";

// Spec: docs/features/audit-log.md. Fixed tokens: acme-responder is user-1, acme-viewer user-2,
// acme-admin user-4, all in tenant-acme.
const alert = { dedupKey: "db-cpu-high", title: "DB CPU above 90%", severity: "sev2" };

describe("audit log contract", () => {
	let system: ReturnType<typeof buildTestSystem>;

	beforeEach(() => {
		system = buildTestSystem();
	});

	const withRequestId = (init: RequestInit, requestId: string): RequestInit => ({
		...init,
		headers: { ...(init.headers as Record<string, string>), "X-Request-ID": requestId },
	});

	const events = async (token: string, query = ""): Promise<AuditEventResponse[]> => {
		const res = await system.app.request(`/v1/audit-events${query}`, authed(token));
		expect(res.status).toBe(200);
		return AuditEventListSchema.parse(await res.json()).items;
	};

	const timeline = async (incidentId: string, token = "acme-viewer") => {
		const res = await system.app.request(`/v1/incidents/${incidentId}/events`, authed(token));
		expect(res.status).toBe(200);
		return AuditEventListSchema.parse(await res.json()).items;
	};

	const createIncident = async (requestId = "req-create-0001") => {
		const res = await system.app.request(
			"/v1/incidents",
			withRequestId(
				authed("acme-responder", { title: "Checkout is down", severity: "sev1" }),
				requestId,
			),
		);
		return IncidentSchema.parse(await res.json());
	};

	describe("incident lifecycle", () => {
		it("records create, acknowledge and resolve with the actor, details and request id", async () => {
			const incident = await createIncident();
			await system.app.request(
				`/v1/incidents/${incident.id}/acknowledge`,
				withRequestId({ ...authed("acme-responder"), method: "POST" }, "req-ack-00000001"),
			);
			await system.app.request(`/v1/incidents/${incident.id}/resolve`, {
				...authed("acme-admin"),
				method: "POST",
			});

			const resource = { type: "incident", id: incident.id };
			expect(await timeline(incident.id)).toMatchObject([
				{
					action: "incident.created",
					actor: { type: "user", id: "user-1" },
					resource,
					details: { title: "Checkout is down", severity: "sev1" },
					requestId: "req-create-0001",
				},
				{
					action: "incident.acknowledged",
					actor: { type: "user", id: "user-1" },
					resource,
					details: {},
					requestId: "req-ack-00000001",
				},
				{ action: "incident.resolved", actor: { type: "user", id: "user-4" }, resource },
			]);
		});

		it("records only the winner of two racing acknowledgements", async () => {
			const incident = await createIncident();
			const acknowledge = () =>
				system.app.request(`/v1/incidents/${incident.id}/acknowledge`, {
					...authed("acme-responder"),
					method: "POST",
				});

			const statuses = (await Promise.all([acknowledge(), acknowledge()])).map((r) => r.status);

			expect(statuses.sort()).toEqual([200, 409]);
			const actions = (await timeline(incident.id)).map((event) => event.action);
			expect(actions).toEqual(["incident.created", "incident.acknowledged"]);
		});

		it("records nothing for a refused change", async () => {
			const res = await system.app.request(
				"/v1/incidents",
				authed("acme-viewer", { title: "Checkout is down", severity: "sev1" }),
			);

			expect(res.status).toBe(403);
			expect(await events("acme-viewer")).toEqual([]);
		});
	});

	describe("alert grouping", () => {
		it("records the source opening an incident, and each alert grouped into it, once", async () => {
			const { sourceId, secret } = await addAlertSource(system.app, "acme-admin");
			const send = async () => {
				const res = await system.app.request(
					`/webhooks/alerts/${sourceId}`,
					signedAlert(secret, alert),
				);
				return AlertAcceptedSchema.parse(await res.json()).alertId;
			};
			const first = await send();
			const second = await send();
			// A duplicate delivery of the first alert's message changes nothing.
			await system.queue.send({ tenantId: "tenant-acme" as TenantId, alertId: first });

			await system.processor.processMessages();

			const [incident] = (await events("acme-viewer", "?action=incident.created")).map(
				(event) => event.resource.id,
			);
			const source = { type: "alert_source", id: sourceId };
			expect(await timeline(incident ?? "")).toMatchObject([
				{
					action: "incident.created",
					actor: source,
					details: { title: "DB CPU above 90%", severity: "sev2" },
					requestId: null,
				},
				{
					action: "alert.grouped",
					actor: source,
					details: { alertId: first, dedupKey: "db-cpu-high" },
				},
				{
					action: "alert.grouped",
					actor: source,
					details: { alertId: second, dedupKey: "db-cpu-high" },
				},
			]);
		});
	});

	describe("members, configuration and sign-ins", () => {
		it("records signup, invite, setup, and sign-ins for known emails only", async () => {
			const ownerToken = await signup(system.app, "owner@initech.example", "Initech");
			const [owner] = MemberListSchema.parse(
				await (await system.app.request("/v1/members", authed(ownerToken))).json(),
			).items;
			const invite = MemberInviteSchema.parse(
				await (
					await system.app.request(
						"/v1/members",
						authed(ownerToken, { email: "milton@initech.example", role: "responder" }),
					)
				).json(),
			);
			const setup = await system.app.request(
				"/v1/auth/setup-password",
				post({ token: invite.setupToken, password: "stapler stapler stapler" }),
			);
			AccessTokenSchema.parse(await setup.json());
			const login = (email: string, password: string) =>
				system.app.request("/v1/auth/login", post({ email, password }));
			expect((await login("milton@initech.example", "not the password")).status).toBe(401);
			expect((await login("milton@initech.example", "stapler stapler stapler")).status).toBe(200);
			expect((await login("nobody@initech.example", "anything at all")).status).toBe(401);

			const milton = { type: "user", id: invite.id };
			expect((await events(ownerToken)).reverse()).toMatchObject([
				{
					action: "tenant.created",
					actor: { type: "user", id: owner?.id },
					resource: { type: "tenant" },
					details: { name: "Initech" },
				},
				{
					action: "member.invited",
					actor: { type: "user", id: owner?.id },
					resource: milton,
					details: { role: "responder" },
				},
				{ action: "member.setup_completed", actor: milton, resource: milton, details: {} },
				{
					action: "user.login_failed",
					actor: { type: "anonymous", id: null },
					resource: milton,
					details: {},
				},
				{ action: "user.login_succeeded", actor: milton, resource: milton, details: {} },
			]);
			// The unknown email had no tenant to record it in.
			expect(await events(ownerToken)).toHaveLength(5);
		});

		it("records a new alert source and notification channel by name only", async () => {
			const { sourceId } = await addAlertSource(system.app, "acme-admin", "grafana");
			const res = await system.app.request(
				"/v1/notification-channels",
				authed("acme-admin", {
					name: "#acme-incidents",
					webhookUrl: "https://hooks.slack.com/services/T000/B000/abcdWXYZ",
				}),
			);
			const { id: channelId } = (await res.json()) as { id: string };

			expect((await events("acme-viewer")).reverse()).toEqual([
				expect.objectContaining({
					action: "alert_source.created",
					actor: { type: "user", id: "user-4" },
					resource: { type: "alert_source", id: sourceId },
					details: { name: "grafana" },
				}),
				expect.objectContaining({
					action: "notification_channel.created",
					resource: { type: "notification_channel", id: channelId },
					details: { name: "#acme-incidents", type: "slack_webhook" },
				}),
			]);
		});
	});

	describe("GET /v1/audit-events", () => {
		it("lets every role read the whole tenant log, newest first", async () => {
			const first = await createIncident();
			const second = await createIncident("req-create-0002");

			for (const token of ["acme-viewer", "acme-responder", "acme-admin"]) {
				expect((await events(token)).map((event) => event.resource.id)).toEqual([
					second.id,
					first.id,
				]);
			}
		});

		it("filters by action, resource, actor and time range, and pages", async () => {
			const incident = await createIncident();
			await system.app.request(`/v1/incidents/${incident.id}/acknowledge`, {
				...authed("acme-admin"),
				method: "POST",
			});
			await createIncident("req-create-0002");
			const all = await events("acme-viewer");
			const oldest = all.at(-1)?.occurredAt ?? "";

			expect((await events("acme-viewer", "?action=incident.acknowledged")).length).toBe(1);
			expect(
				(await events("acme-viewer", `?resourceType=incident&resourceId=${incident.id}`)).length,
			).toBe(2);
			expect((await events("acme-viewer", "?actorId=user-4")).map((e) => e.action)).toEqual([
				"incident.acknowledged",
			]);
			expect((await events("acme-viewer", `?from=${oldest}&to=${oldest}`)).length).toBeGreaterThan(
				0,
			);
			expect(await events("acme-viewer", "?to=2000-01-01T00:00:00Z")).toEqual([]);

			const res = await system.app.request(
				"/v1/audit-events?limit=2&offset=1",
				authed("acme-viewer"),
			);
			const page = AuditEventListSchema.parse(await res.json());
			expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 });
			expect(page.items.map((event) => event.id)).toEqual(all.slice(1, 3).map((event) => event.id));
		});

		it.each([
			["an unknown action", "?action=incident.deleted"],
			["an unknown resource type", "?resourceType=secret"],
			["a malformed time", "?from=yesterday"],
			["from after to", "?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z"],
			["a zero limit", "?limit=0"],
		])("rejects %s with 422", async (_case, query) => {
			const res = await system.app.request(`/v1/audit-events${query}`, authed("acme-viewer"));

			expect(res.status).toBe(422);
			expect(ProblemSchema.parse(await res.json()).code).toBe("VALIDATION_FAILED");
		});

		it("needs a token", async () => {
			const res = await system.app.request("/v1/audit-events");

			expect(res.status).toBe(401);
		});
	});

	describe("GET /v1/incidents/{id}/events", () => {
		it("returns 404 for an unknown incident and 422 for a malformed id", async () => {
			const unknown = await system.app.request(
				"/v1/incidents/00000000-0000-4000-8000-000000000000/events",
				authed("acme-viewer"),
			);
			const malformed = await system.app.request("/v1/incidents/abc/events", authed("acme-viewer"));

			expect(unknown.status).toBe(404);
			expect(ProblemSchema.parse(await unknown.json()).code).toBe("NOT_FOUND");
			expect(malformed.status).toBe(422);
		});
	});
});
