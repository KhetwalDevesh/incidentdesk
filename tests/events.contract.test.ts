import { beforeEach, describe, expect, it } from "vitest";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { STREAM_EVENT_SCHEMAS } from "../src/contract/events";
import { IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema } from "../src/contract/members";
import { OnCallOverrideSchema, OnCallScheduleSchema } from "../src/contract/onCall";
import { addAlertSource, authed, buildTestSystem, post, signedAlert, signup } from "./helpers";
import { openStream, type ReceivedEvent } from "./sse";

// Spec: docs/features/realtime-status.md
const PASSWORD = "correct horse battery";

// Parses each event's data with its contract schema, and returns the names in order.
const checked = (events: ReceivedEvent[]) =>
	events.map((event) => {
		const schema = STREAM_EVENT_SCHEMAS[event.event as keyof typeof STREAM_EVENT_SCHEMAS];
		expect(schema, `unknown event ${event.event}`).toBeDefined();
		schema.parse(event.data);
		return event.event;
	});

describe("realtime events contract", () => {
	let system: ReturnType<typeof buildTestSystem>;
	let admin: string;

	const send = (method: string, path: string, token: string, body?: unknown) =>
		system.app.request(path, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

	const join = async (email: string) => {
		const invited = await system.app.request(
			"/v1/members",
			authed(admin, { email, role: "responder" }),
		);
		const member = MemberInviteSchema.parse(await invited.json());
		const res = await system.app.request(
			"/v1/auth/setup-password",
			post({ token: member.setupToken, password: PASSWORD }),
		);
		return { id: member.id, token: AccessTokenSchema.parse(await res.json()).accessToken };
	};

	const openIncident = async (token = admin) =>
		IncidentSchema.parse(
			await (
				await send("POST", "/v1/incidents", token, { title: "Checkout is down", severity: "sev1" })
			).json(),
		);

	beforeEach(async () => {
		system = buildTestSystem();
		admin = await signup(system.app, "ada@acme.example", "Acme");
	});

	it("opens a text/event-stream that starts with ready and a retry time", async () => {
		const stream = await openStream(system.app, admin);

		expect(stream.res.status).toBe(200);
		expect(stream.res.headers.get("Content-Type")).toContain("text/event-stream");
		expect(await stream.next()).toEqual({ event: "ready", data: {}, retry: 3000 });
		await stream.close();
	});

	it("pushes each incident change with the incident as the API shows it, then a dashboard", async () => {
		const grace = await join("grace@acme.example");
		const stream = await openStream(system.app, grace.token);
		await stream.next();

		const incident = await openIncident();
		await send("POST", `/v1/incidents/${incident.id}/assign`, admin, { assigneeId: grace.id });
		await send("POST", `/v1/incidents/${incident.id}/acknowledge`, grace.token, {});
		await send("POST", `/v1/incidents/${incident.id}/resolve`, grace.token, {});
		// A dashboard may arrive between changes when they are slower than the debounce, so read
		// on to the dashboard that follows the last change.
		const events = await stream.until("incident.resolved");
		events.push(...(await stream.until("dashboard")));
		const changes = events.filter((event) => event.event !== "dashboard");

		checked(events);
		expect(changes.map((event) => event.event)).toEqual([
			"incident.opened",
			"incident.reassigned",
			"incident.acknowledged",
			"incident.resolved",
		]);
		expect(changes[1]?.data).toMatchObject({
			incident: { id: incident.id, assignee: { id: grace.id, email: "grace@acme.example" } },
		});
		expect(changes[3]?.data).toMatchObject({ incident: { status: "resolved" } });
		expect(events.at(-1)).toMatchObject({
			event: "dashboard",
			data: { totals: { open: 0, acknowledged: 0 } },
		});
		await stream.close();
	});

	it("pushes an incident the alert worker opens", async () => {
		const stream = await openStream(system.app, admin);
		await stream.next();
		const { sourceId, secret } = await addAlertSource(system.app, admin);

		await system.app.request(
			`/webhooks/alerts/${sourceId}`,
			signedAlert(secret, { dedupKey: "checkout", title: "Checkout is down", severity: "sev1" }),
		);
		await system.processor.processMessages();
		const [opened] = await stream.until("incident.opened");

		expect(opened?.data).toMatchObject({ incident: { origin: "alert", alertCount: 1 } });
		await stream.close();
	});

	it("pushes on-call schedule and override changes", async () => {
		const grace = await join("grace@acme.example");
		const stream = await openStream(system.app, grace.token);
		await stream.next();

		const created = OnCallScheduleSchema.parse(
			await (
				await send("POST", "/v1/on-call-schedules", admin, {
					name: "Payments",
					timeZone: "UTC",
					handoffTime: "09:00",
					rotationDays: 7,
					startsOn: "2026-01-05",
					participants: [grace.id],
				})
			).json(),
		);
		const path = `/v1/on-call-schedules/${created.id}`;
		await send("PATCH", path, admin, { rotationDays: 14 });
		const override = OnCallOverrideSchema.parse(
			await (
				await send("POST", `${path}/overrides`, grace.token, {
					userId: grace.id,
					startsAt: "2099-01-01T00:00:00Z",
					endsAt: "2099-01-02T00:00:00Z",
				})
			).json(),
		);
		await send("DELETE", `${path}/overrides/${override.id}`, grace.token);
		await send("DELETE", path, admin);
		const events = await stream.until("on_call_schedule.deleted");

		expect(checked(events)).toEqual([
			"on_call_schedule.created",
			"on_call_schedule.updated",
			"on_call_override.created",
			"on_call_override.deleted",
			"on_call_schedule.deleted",
		]);
		expect(events[1]?.data).toMatchObject({ schedule: { id: created.id, rotationDays: 14 } });
		expect(events[2]?.data).toMatchObject({
			scheduleId: created.id,
			override: { id: override.id, email: "grace@acme.example" },
		});
		expect(events[4]?.data).toEqual({ id: created.id });
		await stream.close();
	});

	// Spec: docs/features/ai-summaries.md
	it("pushes a finished summary draft, and the incident when its summary changes", async () => {
		const stream = await openStream(system.app, admin);
		await stream.next();
		const incident = await openIncident();

		await system.summaryProcessor.process();
		const ready = (await stream.until("summary_draft.ready")).at(-1);
		await send("PUT", `/v1/incidents/${incident.id}/summary`, admin, {
			text: "Checkout is slow.",
			severity: "sev2",
		});
		const updated = (await stream.until("incident.updated")).at(-1);

		checked([ready, updated].filter((event): event is ReceivedEvent => event !== undefined));
		expect(ready?.data).toMatchObject({
			incidentId: incident.id,
			draft: { state: "ready", model: "test/fake-model" },
		});
		expect(updated?.data).toMatchObject({
			incident: { id: incident.id, severity: "sev2", summary: { text: "Checkout is slow." } },
		});
		await stream.close();
	});

	it("closes a removed member's stream at once, and tells the others to resync", async () => {
		const grace = await join("grace@acme.example");
		const graceStream = await openStream(system.app, grace.token);
		const adminStream = await openStream(system.app, admin);
		await graceStream.next();
		await adminStream.next();

		await send("DELETE", `/v1/members/${grace.id}`, admin);

		expect(await graceStream.next()).toBeNull();
		expect(await adminStream.next()).toEqual({ event: "resync", data: {}, retry: null });
		expect((await openStream(system.app, grace.token)).res.status).toBe(401);
		await adminStream.close();
	});

	it("closes the stream when its token expires", async () => {
		// Tokens last an hour, and exp is in whole seconds: issued 59m 58s ago, this one has
		// between 1 and 2 seconds left.
		system = buildTestSystem({ tokenNowMs: () => Date.now() - 3_598_000 });
		const shortLived = await signup(system.app, "ada@acme.example", "Acme");
		const stream = await openStream(system.app, shortLived);

		expect(stream.res.status).toBe(200);
		expect((await stream.next())?.event).toBe("ready");
		expect(await stream.next(4000)).toBeNull();
	});

	it("requires a token in the Authorization header", async () => {
		const none = await system.app.request("/v1/events");
		const inQuery = await system.app.request(`/v1/events?token=${admin}`);

		expect(none.status).toBe(401);
		expect(inQuery.status).toBe(401);
		ProblemSchema.parse(await inQuery.json());
	});
});
