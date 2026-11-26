import { beforeEach, describe, expect, it } from "vitest";
import { AlertAcceptedSchema } from "../src/contract/alerts";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { IncidentListSchema, IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema } from "../src/contract/members";
import {
	NotificationChannelSchema,
	NotificationDeliveryListSchema,
} from "../src/contract/notificationChannels";
import { addAlertSource, authed, buildTestSystem, post, signedAlert, signup } from "./helpers";

// Spec: docs/features/slack-delivery.md
const PASSWORD = "correct horse battery";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/abcdWXYZ";

describe("slack delivery contract", () => {
	let system: ReturnType<typeof buildTestSystem>;
	let admin: string;

	beforeEach(async () => {
		system = buildTestSystem();
		admin = await signup(system.app, "ada@acme.example", "Acme");
	});

	const send = (method: string, path: string, token: string) =>
		system.app.request(path, { method, headers: { Authorization: `Bearer ${token}` } });

	const join = async (email: string, role: string) => {
		const invited = await system.app.request("/v1/members", authed(admin, { email, role }));
		const member = MemberInviteSchema.parse(await invited.json());
		const res = await system.app.request(
			"/v1/auth/setup-password",
			post({ token: member.setupToken, password: PASSWORD }),
		);
		return { id: member.id, token: AccessTokenSchema.parse(await res.json()).accessToken };
	};

	const addChannel = async (name = "#incidents", minSeverity = "sev4") => {
		const res = await system.app.request(
			"/v1/notification-channels",
			authed(admin, { name, webhookUrl: WEBHOOK, minSeverity }),
		);
		return NotificationChannelSchema.parse(await res.json()).id;
	};

	const openIncident = async (token: string, severity = "sev1") => {
		const res = await system.app.request(
			"/v1/incidents",
			authed(token, { title: "Checkout is down", severity }),
		);
		return IncidentSchema.parse(await res.json()).id;
	};

	const deliveries = async (channelId: string, token = admin, query = "") => {
		const res = await system.app.request(
			`/v1/notification-channels/${channelId}/deliveries${query}`,
			authed(token),
		);
		expect(res.status).toBe(200);
		return NotificationDeliveryListSchema.parse(await res.json());
	};

	const work = async () => {
		while ((await system.deliveryProcessor.processMessages()) > 0) {
			// Until the queue is empty.
		}
	};

	it("posts opened, acknowledged and resolved to every matching channel, and lists them", async () => {
		const grace = await join("grace@acme.example", "responder");
		const everything = await addChannel("#incidents", "sev4");
		const sev1Only = await addChannel("#oncall", "sev1");

		const id = await openIncident(grace.token, "sev2");
		await system.app.request(`/v1/incidents/${id}/acknowledge`, authed(grace.token, {}));
		await system.app.request(`/v1/incidents/${id}/resolve`, authed(grace.token, {}));
		await work();

		expect(system.sender.texts).toEqual([
			expect.stringMatching(
				/^🟠 SEV2 incident opened: Checkout is down\nOpened by grace@acme\.example · incident /,
			),
			expect.stringMatching(
				/^✅ SEV2 incident acknowledged: .*\nAcknowledged by grace@acme\.example after /,
			),
			expect.stringMatching(
				/^🟢 SEV2 incident resolved: .*\nResolved by grace@acme\.example after /,
			),
		]);
		const listed = await deliveries(everything);
		expect(listed).toMatchObject({ total: 3, limit: 20, offset: 0 });
		expect(listed.items.map((d) => d.event).sort()).toEqual([
			"incident.acknowledged",
			"incident.opened",
			"incident.resolved",
		]);
		expect(listed.items[0]).toEqual({
			id: expect.any(String),
			event: expect.any(String),
			incidentId: id,
			state: "delivered",
			attempts: 1,
			failureReason: null,
			lastStatus: 200,
			createdAt: expect.any(String),
			deliveredAt: expect.any(String),
		});
		expect((await deliveries(sev1Only)).total).toBe(0);
	});

	it("posts once when an alert opens an incident, and not for alerts that join it", async () => {
		const channel = await addChannel();
		const { sourceId, secret } = await addAlertSource(system.app, admin, "prometheus");
		const alert = {
			dedupKey: "checkout",
			status: "firing",
			title: "Checkout is down",
			severity: "sev1",
		};

		for (let n = 0; n < 3; n++) {
			const res = await system.app.request(
				`/webhooks/alerts/${sourceId}`,
				signedAlert(secret, alert),
			);
			AlertAcceptedSchema.parse(await res.json());
		}
		while ((await system.processor.processMessages()) > 0) {
			// Until every alert is grouped.
		}
		await work();

		expect(system.sender.texts).toEqual([
			expect.stringMatching(
				/^🔴 SEV1 incident opened: Checkout is down\nOpened by alert source prometheus · 1 alert · incident /,
			),
		]);
		const incidents = IncidentListSchema.parse(
			await (await system.app.request("/v1/incidents", authed(admin))).json(),
		);
		expect(incidents.items[0]?.alertCount).toBe(3);
		expect((await deliveries(channel)).total).toBe(1);
	});

	it("names a member removed before the post by their email", async () => {
		await addChannel();
		const grace = await join("grace@acme.example", "responder");
		await openIncident(grace.token);

		await send("DELETE", `/v1/members/${grace.id}`, admin);
		await work();

		expect(system.sender.texts[0]).toContain("Opened by grace@acme.example");
		expect(JSON.stringify(system.deliveries.allSync())).not.toContain("grace@acme.example");
	});

	it("shows a rejected delivery's reason and Slack's status, but nothing Slack said", async () => {
		const channel = await addChannel();
		system.sender.answers = [{ kind: "response", status: 404, retryAfter: null }];

		await openIncident(admin);
		await work();

		const [delivery] = (await deliveries(channel)).items;
		expect(delivery).toMatchObject({
			state: "failed",
			failureReason: "rejected",
			lastStatus: 404,
			deliveredAt: null,
		});
	});

	it("pages deliveries newest first", async () => {
		const channel = await addChannel();
		const first = await openIncident(admin);
		const second = await openIncident(admin);

		const page = await deliveries(channel, admin, "?limit=1&offset=1");

		expect(page).toMatchObject({ total: 2, limit: 1, offset: 1 });
		expect([first, second]).toContain(page.items[0]?.incidentId);
	});

	it("lets only admins list deliveries", async () => {
		const channel = await addChannel();
		const responder = await join("grace@acme.example", "responder");

		for (const token of [responder.token]) {
			const res = await system.app.request(
				`/v1/notification-channels/${channel}/deliveries`,
				authed(token),
			);
			expect(res.status).toBe(403);
			ProblemSchema.parse(await res.json());
		}
	});

	it("returns 404 for an unknown channel and 422 for a bad id or page", async () => {
		const channel = await addChannel();
		const cases: [string, number][] = [
			["/v1/notification-channels/00000000-0000-4000-8000-000000000000/deliveries", 404],
			["/v1/notification-channels/abc/deliveries", 422],
			[`/v1/notification-channels/${channel}/deliveries?limit=0`, 422],
		];
		for (const [path, status] of cases) {
			const res = await system.app.request(path, authed(admin));
			expect(res.status).toBe(status);
			ProblemSchema.parse(await res.json());
		}
	});

	// Spec: docs/features/on-call-schedules.md, "Slack message".
	describe("on-call assignment", () => {
		const schedule = async (participants: string[]) => {
			const res = await system.app.request(
				"/v1/on-call-schedules",
				authed(admin, {
					name: "Payments",
					timeZone: "UTC",
					handoffTime: "00:00",
					rotationDays: 7,
					startsOn: "2020-01-06",
					participants,
					isDefault: true,
				}),
			);
			expect(res.status).toBe(201);
		};

		const assign = (id: string, token: string, assigneeId: string | null) =>
			system.app.request(`/v1/incidents/${id}/assign`, authed(token, { assigneeId }));

		it("names the assignee when an incident opens, and drops the email once posted", async () => {
			const grace = await join("grace@acme.example", "responder");
			await addChannel();
			await schedule([grace.id]);

			await openIncident(admin);
			await work();

			expect(system.sender.texts[0]).toMatch(/\nAssigned to grace@acme\.example$/);
			expect(JSON.stringify(system.deliveries.allSync())).not.toContain("grace@acme.example");
		});

		it("says Unassigned when nobody is on call", async () => {
			await addChannel();

			await openIncident(admin);
			await work();

			expect(system.sender.texts[0]).toMatch(/\nUnassigned$/);
		});

		it("posts each reassignment once, naming both people, and a no-op not at all", async () => {
			const grace = await join("grace@acme.example", "responder");
			const alan = await join("alan@acme.example", "responder");
			const channel = await addChannel();
			await schedule([grace.id]);
			const id = await openIncident(admin);

			await assign(id, grace.token, alan.id);
			await assign(id, alan.token, alan.id);
			await assign(id, admin, null);
			await work();

			expect(system.sender.texts.slice(1)).toEqual([
				expect.stringMatching(
					/^👤 SEV1 incident reassigned: Checkout is down\nReassigned to alan@acme\.example by grace@acme\.example · incident /,
				),
				expect.stringMatching(/\nUnassigned by ada@acme\.example · incident /),
			]);
			const listed = await deliveries(channel);
			expect(listed.items.filter((d) => d.event === "incident.reassigned")).toHaveLength(2);
			expect(JSON.stringify(system.deliveries.allSync())).not.toMatch(/(alan|grace)@acme/);
		});
	});

	it("still changes the incident when the notification queue is down", async () => {
		const channel = await addChannel();
		system.notificationQueue.failSends = true;

		const res = await system.app.request(
			"/v1/incidents",
			authed(admin, { title: "Checkout is down", severity: "sev1" }),
		);

		expect(res.status).toBe(201);
		expect((await deliveries(channel)).items[0]).toMatchObject({ state: "pending" });
	});
});
