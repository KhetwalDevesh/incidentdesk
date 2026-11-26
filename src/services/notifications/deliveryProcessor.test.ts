import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { anAudit } from "../../../tests/auditEntries";
import { createAesGcmSecretBox } from "../../adapters/aesGcmSecretBox";
import { InMemoryQueue } from "../../adapters/inMemoryQueue";
import type { IncidentId } from "../../contract/incidents";
import type { Incident } from "../../domain/incidents/types";
import {
	channelSecretContext,
	createWebhookPolicy,
	type DeliveryActor,
	type DeliveryRef,
	type NotificationEvent,
	type WebhookResult,
	type WebhookSender,
} from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";
import { InMemoryIncidentRepository } from "../../repository/incidents/inMemoryIncidentRepository";
import { InMemoryNotificationChannelRepository } from "../../repository/notifications/inMemoryNotificationChannelRepository";
import { InMemoryNotificationDeliveryRepository } from "../../repository/notifications/inMemoryNotificationDeliveryRepository";
import { createDeliveryDispatcher } from "./deliveryDispatcher";
import {
	createDeliveryProcessor,
	DELIVERY_DEADLINE_MS,
	DELIVERY_MAX_ATTEMPTS,
	DELIVERY_MAX_RETRY_AFTER_MS,
	DELIVERY_RETRY_DELAYS_MS,
	DELIVERY_SENT_RESEND_MS,
	DELIVERY_UNSENT_RESEND_MS,
	parseRetryAfter,
} from "./deliveryProcessor";
import { escapeMrkdwn, formatDuration, slackMessage } from "./slackMessage";

// Spec: docs/features/slack-delivery.md
const tenant = randomUUID() as TenantId;
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secretPart";
const start = new Date("2026-01-01T00:00:00.000Z");
const VISIBILITY_MS = 60_000;

const ok200: WebhookResult = { kind: "response", status: 200, retryAfter: null };
const status = (code: number, retryAfter: string | null = null): WebhookResult => ({
	kind: "response",
	status: code,
	retryAfter,
});

const setup = () => {
	let clock = start.getTime();
	const now = () => new Date(clock);
	const advance = (ms: number) => {
		clock += ms;
	};
	const secrets = createAesGcmSecretBox(Buffer.alloc(32, 7).toString("base64"));
	const channels = new InMemoryNotificationChannelRepository();
	const deliveries = new InMemoryNotificationDeliveryRepository(channels);
	const incidents = new InMemoryIncidentRepository(undefined, deliveries);
	const queue = new InMemoryQueue<DeliveryRef>({ now, visibilityTimeoutMs: VISIBILITY_MS });
	const dispatcher = createDeliveryDispatcher({ deliveries, queue, now });

	const posts: { url: string; body: unknown }[] = [];
	let answers: WebhookResult[] = [ok200];
	const sender: WebhookSender = {
		async post(url, body) {
			posts.push({ url, body });
			const answer = answers.length > 1 ? answers.shift() : answers[0];
			return answer ?? ok200;
		},
	};
	// The text of the nth message posted, or "" when there is none.
	const text = (n: number) => (posts[n]?.body as { text?: string } | undefined)?.text ?? "";
	const answer = (...next: WebhookResult[]) => {
		answers = next;
	};

	const errors: { subject: string; error: unknown }[] = [];
	const processor = createDeliveryProcessor({
		queue,
		deliveries,
		outbox: deliveries,
		channels,
		secrets,
		sender,
		policy: createWebhookPolicy(["https://hooks.slack.com"]),
		now,
		visibilityTimeoutMs: VISIBILITY_MS,
		onError: (subject, error) => errors.push({ subject, error }),
	});

	// Stores a channel directly, as one created before the allowlist would be.
	const addChannel = async (url = WEBHOOK) => {
		const id = randomUUID();
		await channels.create(
			tenant,
			{
				id,
				kind: "slack_webhook",
				name: `#${id}`,
				targetCiphertext: secrets.seal(url, channelSecretContext(tenant, id)),
				targetHint: url.slice(-4),
				minSeverity: "sev4",
				enabled: true,
				createdAt: now(),
			},
			anAudit(tenant),
		);
		return id;
	};

	// Opens an incident with a notice, and sends its queue messages, as the incident service does.
	const open = async (
		{
			title = "Checkout is down",
			actor = { type: "user", email: "grace@acme.example" } as DeliveryActor,
			event = "incident.opened" as NotificationEvent,
		} = {},
		dispatch = true,
	) => {
		const incident: Omit<Incident, "tenantId"> = {
			id: randomUUID() as IncidentId,
			title,
			severity: "sev1",
			status: "open",
			createdAt: now(),
			createdBy: "user-1",
			acknowledgedAt: null,
			acknowledgedBy: null,
			resolvedAt: null,
			resolvedBy: null,
			alertSourceId: null,
			dedupKey: null,
			alertCount: 3,
			lastAlertAt: null,
			assigneeId: null,
			assignmentCount: 0,
		};
		await incidents.create(tenant, incident, [anAudit(tenant)], {
			incidentId: incident.id,
			event,
			severity: incident.severity,
			createdAt: now(),
			payload: {
				title,
				severity: incident.severity,
				actor,
				alertCount: incident.alertCount,
				openedAt: incident.createdAt.toISOString(),
				occurredAt: now().toISOString(),
			},
		});
		if (dispatch) await dispatcher.dispatch(tenant, incident.id, event);
		return incident;
	};

	const only = () => {
		const [delivery] = deliveries.allSync();
		if (!delivery) throw new Error("no delivery");
		return delivery;
	};

	// Runs the worker until the queue has nothing visible, advancing to each retry.
	const drain = async (maxRounds = 50) => {
		for (let round = 0; round < maxRounds; round++) {
			if ((await processor.processMessages()) === 0) {
				const next = deliveries.allSync().find((d) => d.state === "pending");
				if (!next || queue.size === 0) return;
				advance(Math.max(1, next.nextAttemptAt.getTime() - clock));
			}
		}
	};

	return {
		now,
		advance,
		channels,
		deliveries,
		queue,
		processor,
		posts,
		text,
		answer,
		errors,
		addChannel,
		open,
		only,
		drain,
	};
};

describe("delivery processor", () => {
	it("posts the message, marks it delivered, deletes the queue message and removes the email", async () => {
		const t = setup();
		await t.addChannel();
		await t.open();

		await t.processor.processMessages();

		expect(t.posts).toHaveLength(1);
		expect(t.posts[0]?.url).toBe(WEBHOOK);
		expect(t.text(0)).toContain("SEV1 incident opened: Checkout is down");
		expect(t.text(0)).toContain("Opened by grace@acme.example");
		expect(t.only()).toMatchObject({
			state: "delivered",
			attempts: 1,
			lastStatus: 200,
			deliveredAt: t.now(),
			payload: { actor: { type: "user", email: null } },
		});
		expect(t.queue.size).toBe(0);
	});

	it.each([
		["a 5xx", status(503), 503, "HTTP 503"],
		["a 408", status(408), 408, "HTTP 408"],
		["a timeout", { kind: "error", error: "timeout" } as WebhookResult, null, "timeout"],
		[
			"a network error",
			{ kind: "error", error: "network error" } as WebhookResult,
			null,
			"network error",
		],
	])("retries %s with backoff, then fails after 5 attempts", async (_case, result, last, error) => {
		const t = setup();
		await t.addChannel();
		await t.open();
		t.answer(result);
		const delays: number[] = [];

		for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
			const before = t.now().getTime();
			await t.processor.processMessages();
			const delivery = t.only();
			if (delivery.state === "pending") {
				delays.push(delivery.nextAttemptAt.getTime() - before);
				t.advance(delivery.nextAttemptAt.getTime() - before);
			}
		}

		expect(delays).toEqual([...DELIVERY_RETRY_DELAYS_MS]);
		expect(t.posts).toHaveLength(DELIVERY_MAX_ATTEMPTS);
		expect(t.only()).toMatchObject({
			state: "failed",
			failureReason: "unavailable",
			attempts: DELIVERY_MAX_ATTEMPTS,
			lastStatus: last,
			lastError: error,
			payload: { actor: { email: null } },
		});
		expect(t.queue.size).toBe(0);
	});

	it("delivers on a later attempt after a transient failure", async () => {
		const t = setup();
		await t.addChannel();
		await t.open();
		t.answer(status(500), status(502), ok200);

		await t.drain();

		expect(t.posts).toHaveLength(3);
		expect(t.only()).toMatchObject({ state: "delivered", attempts: 3, lastStatus: 200 });
	});

	it.each([
		["404 no_service", 404],
		["403 invalid_token", 403],
		["410 channel_is_archived", 410],
		["400 invalid_payload", 400],
		["a redirect", 302],
	])("fails %s at once, without retrying", async (_case, code) => {
		const t = setup();
		await t.addChannel();
		await t.open();
		t.answer(status(code));

		await t.drain();

		expect(t.posts).toHaveLength(1);
		expect(t.only()).toMatchObject({
			state: "failed",
			failureReason: "rejected",
			attempts: 1,
			lastStatus: code,
		});
		expect(t.queue.size).toBe(0);
	});

	describe("rate limits (429)", () => {
		it("waits Retry-After seconds and does not count the attempt", async () => {
			const t = setup();
			await t.addChannel();
			await t.open();
			t.answer(status(429, "7"), ok200);

			await t.processor.processMessages();
			expect(t.only()).toMatchObject({
				state: "pending",
				attempts: 0,
				lastStatus: 429,
				nextAttemptAt: new Date(start.getTime() + 7000),
			});
			t.advance(6999);
			expect(await t.processor.processMessages()).toBe(0);
			t.advance(1);
			await t.processor.processMessages();

			expect(t.only()).toMatchObject({ state: "delivered", attempts: 1 });
		});

		it("caps Retry-After at 10 minutes, and falls back to the backoff when it cannot be read", async () => {
			const t = setup();
			await t.addChannel();
			await t.open();
			t.answer(status(429, "86400"));

			await t.processor.processMessages();
			expect(t.only().nextAttemptAt.getTime() - start.getTime()).toBe(DELIVERY_MAX_RETRY_AFTER_MS);

			const u = setup();
			await u.addChannel();
			await u.open();
			u.answer(status(429, "soon"));
			await u.processor.processMessages();
			expect(u.only().nextAttemptAt.getTime() - start.getTime()).toBe(DELIVERY_RETRY_DELAYS_MS[0]);
		});

		it("keeps retrying past 5 rate-limited answers, then fails 1 hour after creation", async () => {
			const t = setup();
			await t.addChannel();
			await t.open();
			t.answer(status(429, "600"));

			await t.drain(100);

			const delivery = t.only();
			expect(t.posts.length).toBeGreaterThan(DELIVERY_MAX_ATTEMPTS);
			expect(delivery).toMatchObject({
				state: "failed",
				failureReason: "unavailable",
				lastStatus: 429,
			});
			expect(t.now().getTime() - start.getTime()).toBeLessThanOrEqual(DELIVERY_DEADLINE_MS);
		});
	});

	it("refuses a webhook whose origin is not allowed, without calling it", async () => {
		const t = setup();
		await t.addChannel("http://169.254.169.254/latest/meta-data");
		await t.open();

		await t.processor.processMessages();

		expect(t.posts).toEqual([]);
		expect(t.only()).toMatchObject({
			state: "failed",
			failureReason: "host_not_allowed",
			lastStatus: null,
		});
	});

	it("posts a duplicate message once", async () => {
		const t = setup();
		await t.addChannel();
		await t.open();
		await t.queue.send({ tenantId: tenant, deliveryId: t.only().id });

		await t.processor.processMessages();
		t.advance(VISIBILITY_MS);
		await t.processor.processMessages();

		expect(t.posts).toHaveLength(1);
		expect(t.queue.size).toBe(0);
	});

	it("leaves a duplicate alone while another attempt holds the delivery", async () => {
		const t = setup();
		await t.addChannel();
		await t.open();
		const { id } = t.only();
		// The first attempt crashed after starting: the delivery is held until the lease ends.
		await t.deliveries.startAttempt(tenant, id, t.now(), new Date(start.getTime() + VISIBILITY_MS));

		await t.processor.processMessages();
		expect(t.posts).toEqual([]);
		expect(t.queue.size).toBe(1);

		t.advance(VISIBILITY_MS);
		await t.processor.processMessages();
		expect(t.posts).toHaveLength(1);
		expect(t.only()).toMatchObject({ state: "delivered", attempts: 2 });
	});

	it("fails a delivery whose attempts never finished", async () => {
		const t = setup();
		await t.addChannel();
		await t.open();
		const { id } = t.only();
		for (let n = 0; n < DELIVERY_MAX_ATTEMPTS; n++) {
			await t.deliveries.startAttempt(tenant, id, t.now(), t.now());
		}

		await t.processor.processMessages();

		expect(t.posts).toEqual([]);
		expect(t.only()).toMatchObject({ state: "failed", failureReason: "unavailable" });
	});

	it("deletes a malformed message and reports its id only", async () => {
		const t = setup();
		t.queue.sendRaw("not json");
		t.queue.sendRaw(JSON.stringify({ tenantId: tenant }));

		await t.processor.processMessages();

		expect(t.queue.size).toBe(0);
		expect(t.errors.map((e) => e.subject)).toEqual([
			expect.stringMatching(/^message /),
			expect.stringMatching(/^message /),
		]);
	});

	describe("sweeper", () => {
		it("sends a delivery whose message was never sent, once it is 2 minutes overdue", async () => {
			const t = setup();
			await t.addChannel();
			await t.open({}, false);

			t.advance(DELIVERY_UNSENT_RESEND_MS - 1);
			expect(await t.processor.sweep()).toBe(0);
			t.advance(1);
			expect(await t.processor.sweep()).toBe(1);
			await t.processor.processMessages();

			expect(t.only()).toMatchObject({ state: "delivered" });
		});

		it("re-sends a sent delivery only after 15 minutes, when its message was lost", async () => {
			const t = setup();
			await t.addChannel();
			await t.open();
			// The message is lost: received, never deleted, then gone (as if the DLQ took it).
			await t.queue.receive(10, 0);
			const lost = t.queue.size;

			t.advance(DELIVERY_SENT_RESEND_MS - 1);
			expect(await t.processor.sweep()).toBe(0);
			t.advance(1);
			expect(await t.processor.sweep()).toBe(1);

			expect(lost).toBe(1);
			expect(t.queue.size).toBe(2);
		});
	});

	it("names a member removed before the send as a removed member", async () => {
		const t = setup();
		await t.addChannel();
		await t.open({ actor: { type: "user", email: null } });

		await t.processor.processMessages();

		expect(t.text(0)).toContain("Opened by a removed member");
	});

	it("never puts the webhook URL in a queue message, a row or an error report", async () => {
		const t = setup();
		await t.addChannel();
		await t.open();
		const bodies = [...t.queue.bodies];
		t.answer({ kind: "error", error: "network error" });

		await t.processor.processMessages();

		for (const text of [
			...bodies,
			JSON.stringify(t.deliveries.allSync()),
			...t.errors.map(String),
		]) {
			expect(text).not.toContain("secretPart");
			expect(text).not.toContain("hooks.slack.com");
		}
	});
});

describe("Slack message", () => {
	it("escapes a title so it cannot mention a channel or create a link", () => {
		const { text } = slackMessage("incident.opened", randomUUID(), {
			title: "<!channel> <@U123> <https://evil.example|click> & more",
			severity: "sev2",
			actor: { type: "alert_source", name: "<!here>" },
			alertCount: 1,
			openedAt: start.toISOString(),
			occurredAt: start.toISOString(),
		});

		expect(text).not.toMatch(/[<>]/);
		expect(text).toContain(
			"&lt;!channel&gt; &lt;@U123&gt; &lt;https://evil.example|click&gt; &amp; more",
		);
		expect(text).toContain("Opened by alert source &lt;!here&gt; · 1 alert");
	});

	it("reads as each event, with the time since the incident opened", () => {
		const payload = {
			title: "Checkout is down",
			severity: "sev1" as const,
			actor: { type: "user" as const, email: "grace@acme.example" },
			alertCount: 0,
			openedAt: start.toISOString(),
			occurredAt: new Date(start.getTime() + 159_000).toISOString(),
		};
		const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

		expect(slackMessage("incident.opened", id, payload).text).toBe(
			"🔴 SEV1 incident opened: Checkout is down\nOpened by grace@acme.example · incident 7c9e6679",
		);
		expect(slackMessage("incident.acknowledged", id, payload).text).toBe(
			"✅ SEV1 incident acknowledged: Checkout is down\nAcknowledged by grace@acme.example after 2m 39s · incident 7c9e6679",
		);
		expect(slackMessage("incident.resolved", id, payload).text).toBe(
			"🟢 SEV1 incident resolved: Checkout is down\nResolved by grace@acme.example after 2m 39s · incident 7c9e6679",
		);
	});

	// Spec: docs/features/on-call-schedules.md, "Slack message".
	describe("assignee", () => {
		const payload = {
			title: "Checkout is down",
			severity: "sev1" as const,
			actor: { type: "user" as const, email: "ada@acme.example" },
			alertCount: 0,
			openedAt: start.toISOString(),
			occurredAt: start.toISOString(),
		};
		const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
		const opened =
			"🔴 SEV1 incident opened: Checkout is down\nOpened by ada@acme.example · incident 7c9e6679";

		it("names the assignee in the opened message, or says it is unassigned", () => {
			const assigned = { ...payload, assignee: { email: "grace@acme.example" } };

			expect(slackMessage("incident.opened", id, assigned).text).toBe(
				`${opened}\nAssigned to grace@acme.example`,
			);
			expect(slackMessage("incident.opened", id, { ...payload, assignee: null }).text).toBe(
				`${opened}\nUnassigned`,
			);
			// Recorded before assignment existed: no line at all.
			expect(slackMessage("incident.opened", id, payload).text).toBe(opened);
		});

		it("says who reassigned it to whom, or who unassigned it", () => {
			const reassigned = { ...payload, assignee: { email: "alan@acme.example" } };

			expect(slackMessage("incident.reassigned", id, reassigned).text).toBe(
				"👤 SEV1 incident reassigned: Checkout is down\nReassigned to alan@acme.example by ada@acme.example · incident 7c9e6679",
			);
			expect(slackMessage("incident.reassigned", id, { ...payload, assignee: null }).text).toBe(
				"👤 SEV1 incident reassigned: Checkout is down\nUnassigned by ada@acme.example · incident 7c9e6679",
			);
		});

		it("escapes the assignee, and names a removed one without their email", () => {
			const sneaky = { ...payload, assignee: { email: "<!channel>@acme.example" } };

			expect(slackMessage("incident.reassigned", id, sneaky).text).toContain(
				"Reassigned to &lt;!channel&gt;@acme.example",
			);
			expect(
				slackMessage("incident.opened", id, { ...payload, assignee: { email: null } }).text,
			).toContain("Assigned to a removed member");
		});
	});

	it.each([
		[45_000, "45s"],
		[159_000, "2m 39s"],
		[3_900_000, "1h 5m"],
		[266_400_000, "3d 2h"],
	])("formats %i ms as %s", (ms, text) => {
		expect(formatDuration(ms)).toBe(text);
	});

	it("escapes only Slack's three control characters", () => {
		expect(escapeMrkdwn("a & b < c > d *bold*")).toBe("a &amp; b &lt; c &gt; d *bold*");
	});
});

describe("parseRetryAfter", () => {
	it.each([
		["7", 7000],
		[" 0 ", 0],
		["Wed, 01 Jan 2026 00:00:30 GMT", 30_000],
		["Wed, 31 Dec 2025 23:00:00 GMT", 0],
		["soon", null],
		["-5", null],
		[null, null],
	])("reads %s as %s ms", (value, ms) => {
		expect(parseRetryAfter(value, start)).toBe(ms);
	});
});
