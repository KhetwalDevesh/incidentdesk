import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { anAudit, groupingAudit } from "../../../tests/auditEntries";
import { InMemoryQueue } from "../../adapters/inMemoryQueue";
import type { IncidentId } from "../../contract/incidents";
import type {
	Alert,
	AlertRef,
	AlertRepository,
	AlertSourceLookup,
} from "../../domain/alerts/types";
import type { OnCallAssigner } from "../../domain/onCall/types";
import type { TenantId } from "../../domain/shared/identity";
import { InMemoryAlertRepository } from "../../repository/alerts/inMemoryAlertRepository";
import { InMemoryIncidentRepository } from "../../repository/incidents/inMemoryIncidentRepository";
import {
	ALERT_MAX_ATTEMPTS,
	ALERT_RETRY_DELAYS_MS,
	ALERT_SENT_RESEND_MS,
	ALERT_UNSENT_RESEND_MS,
	createAlertProcessor,
} from "./alertProcessor";

const tenant = "tenant-a" as TenantId;
const SOURCE = "00000000-0000-4000-8000-000000000001";
const start = new Date("2026-01-01T00:00:00.000Z");
const VISIBILITY_MS = 60_000;

const setup = () => {
	let clock = start.getTime();
	const now = () => new Date(clock);
	const incidents = new InMemoryIncidentRepository();
	const alerts = new InMemoryAlertRepository(incidents);
	const queue = new InMemoryQueue<AlertRef>({ now, visibilityTimeoutMs: VISIBILITY_MS });
	const errors: string[] = [];
	const processorWith = (repository: AlertRepository = alerts, batchSize = 10) =>
		createAlertProcessor({
			queue,
			alerts: repository,
			outbox: alerts,
			now,
			batchSize,
			visibilityTimeoutMs: VISIBILITY_MS,
			onError: (subject) => errors.push(subject),
		});
	const advance = (ms: number) => {
		clock += ms;
	};
	// Saves the alert without sending it, as when the webhook's send failed.
	const store = (overrides: Partial<Alert> = {}) =>
		alerts.enqueue(tenant, {
			id: randomUUID(),
			sourceId: SOURCE,
			dedupKey: "db-cpu-high",
			status: "firing",
			title: "DB CPU above 90%",
			severity: "sev2",
			details: {},
			state: "pending",
			attempts: 0,
			nextAttemptAt: now(),
			lastError: null,
			incidentId: null,
			receivedAt: now(),
			processedAt: null,
			sentAt: null,
			...overrides,
		});
	// Saves and sends the alert, as the webhook does.
	const send = async (overrides: Partial<Alert> = {}) => {
		const alert = await store(overrides);
		await queue.send({ tenantId: tenant, alertId: alert.id });
		await alerts.markSent(tenant, alert.id, now());
		return alert;
	};
	const allIncidents = async () => (await incidents.list(tenant, { limit: 100, offset: 0 })).items;
	const allAlerts = async () => (await alerts.list(tenant, { limit: 100, offset: 0 })).items;
	return {
		incidents,
		alerts,
		queue,
		errors,
		processor: processorWith(),
		processorWith,
		advance,
		store,
		send,
		allIncidents,
		allAlerts,
	};
};

// complete() always throws, as when the database is down mid-transaction.
const throwingComplete = (alerts: InMemoryAlertRepository): AlertRepository => ({
	enqueue: alerts.enqueue.bind(alerts),
	list: alerts.list.bind(alerts),
	markSent: alerts.markSent.bind(alerts),
	startAttempt: alerts.startAttempt.bind(alerts),
	fail: alerts.fail.bind(alerts),
	listForIncident: alerts.listForIncident.bind(alerts),
	complete: async () => {
		throw new Error("database is down");
	},
});

describe("alertProcessor grouping", () => {
	it("opens an incident for a new key, with the alert's title and severity", async () => {
		const { processor, send, allIncidents, allAlerts } = setup();
		const alert = await send();

		expect(await processor.processMessages()).toBe(1);

		const [incident] = await allIncidents();
		expect(incident).toMatchObject({
			title: "DB CPU above 90%",
			severity: "sev2",
			status: "open",
			createdBy: `alert_source:${SOURCE}`,
			alertSourceId: SOURCE,
			dedupKey: "db-cpu-high",
			alertCount: 1,
			lastAlertAt: alert.receivedAt,
			assigneeId: null,
			assignmentCount: 0,
			summary: null,
		});
		expect(await allAlerts()).toMatchObject([
			{ id: alert.id, state: "processed", incidentId: incident?.id, attempts: 1 },
		]);
	});

	it("deletes each message once its alert is grouped", async () => {
		const { processor, queue, send, advance } = setup();
		await send();

		await processor.processMessages();
		advance(24 * 60 * 60 * 1000);

		expect(queue.size).toBe(0);
		expect(await processor.processMessages()).toBe(0);
	});

	it("attaches a repeat key to the unresolved incident and counts it", async () => {
		const { processor, send, advance, allIncidents } = setup();
		await send();
		advance(1000);
		const repeat = await send({ title: "A different title", severity: "sev1" });

		await processor.processMessages();

		const incidents = await allIncidents();
		expect(incidents).toHaveLength(1);
		// Later alerts never change the title or severity. A person does.
		expect(incidents[0]).toMatchObject({
			title: "DB CPU above 90%",
			severity: "sev2",
			alertCount: 2,
			lastAlertAt: repeat.receivedAt,
			assigneeId: null,
			assignmentCount: 0,
			summary: null,
		});
	});

	it("attaches to an acknowledged incident without changing its status", async () => {
		const { incidents, processor, send, allIncidents } = setup();
		await send();
		await processor.processMessages();
		const [opened] = await allIncidents();
		await incidents.update(
			tenant,
			opened?.id as IncidentId,
			{ status: "open", assigneeId: null },
			{ status: "acknowledged" },
			anAudit(tenant, "incident.acknowledged"),
		);

		await send();
		await processor.processMessages();

		expect(await allIncidents()).toMatchObject([{ status: "acknowledged", alertCount: 2 }]);
	});

	it("opens a new incident when the last one for the key is resolved", async () => {
		const { incidents, processor, send, allIncidents } = setup();
		await send();
		await processor.processMessages();
		const [first] = await allIncidents();
		await incidents.update(
			tenant,
			first?.id as IncidentId,
			{ status: "open", assigneeId: null },
			{ status: "resolved" },
			anAudit(tenant, "incident.acknowledged"),
		);

		await send();
		await processor.processMessages();

		const all = await allIncidents();
		expect(all).toHaveLength(2);
		expect(all.filter((incident) => incident.status === "open")).toHaveLength(1);
	});

	it("keeps different keys and different sources apart", async () => {
		const { processor, send, allIncidents } = setup();
		await send();
		await send({ dedupKey: "disk-full" });
		await send({ sourceId: "00000000-0000-4000-8000-000000000002" });

		await processor.processMessages();

		expect(await allIncidents()).toHaveLength(3);
	});

	it("attaches a resolved alert but leaves the incident open", async () => {
		const { processor, send, allIncidents, allAlerts } = setup();
		await send();
		await processor.processMessages();

		await send({ status: "resolved" });
		await processor.processMessages();

		const [incident] = await allIncidents();
		expect(incident).toMatchObject({ status: "open", alertCount: 2 });
		expect((await allAlerts()).every((alert) => alert.incidentId === incident?.id)).toBe(true);
	});

	it("stores a resolved alert with no incident when none is unresolved", async () => {
		const { processor, send, allIncidents, allAlerts } = setup();
		await send({ status: "resolved" });

		await processor.processMessages();

		expect(await allIncidents()).toEqual([]);
		expect(await allAlerts()).toMatchObject([{ state: "processed", incidentId: null }]);
	});
});

describe("alertProcessor messages", () => {
	it("groups an alert once when its message arrives twice", async () => {
		const { processor, queue, send, allIncidents, allAlerts } = setup();
		const alert = await send();
		await queue.send({ tenantId: tenant, alertId: alert.id });

		expect(await processor.processMessages()).toBe(2);

		expect(await allIncidents()).toMatchObject([{ alertCount: 1 }]);
		expect(await allAlerts()).toMatchObject([{ state: "processed", attempts: 1 }]);
		expect(queue.size).toBe(0);
	});

	it("deletes a malformed message and logs it by message id only", async () => {
		const { processor, queue, errors, allIncidents } = setup();
		queue.sendRaw("not json");
		queue.sendRaw(JSON.stringify({ tenantId: tenant }));
		queue.sendRaw(JSON.stringify({ tenantId: 7, alertId: "x" }));
		queue.sendRaw(JSON.stringify({ tenantId: tenant, alertId: "a".repeat(201) }));

		expect(await processor.processMessages()).toBe(4);

		expect(queue.size).toBe(0);
		expect(errors).toHaveLength(4);
		expect(errors.every((subject) => /^message [0-9a-f-]{36}$/.test(subject))).toBe(true);
		expect(await allIncidents()).toEqual([]);
	});

	it("deletes a message for an unknown alert, or for a known alert under another tenant", async () => {
		const { processor, queue, store, allIncidents, allAlerts, errors } = setup();
		const alert = await store();
		await queue.send({ tenantId: tenant, alertId: randomUUID() });
		await queue.send({ tenantId: "tenant-b" as TenantId, alertId: alert.id });

		expect(await processor.processMessages()).toBe(2);

		expect(queue.size).toBe(0);
		expect(errors).toEqual([]);
		expect(await allIncidents()).toEqual([]);
		expect(await allAlerts()).toMatchObject([{ state: "pending", attempts: 0 }]);
	});
});

describe("alertProcessor failures", () => {
	it("retries with backoff through message visibility, then marks the alert failed", async () => {
		const { alerts, queue, errors, processorWith, send, advance, allAlerts } = setup();
		const processor = processorWith(throwingComplete(alerts));
		const alert = await send();

		for (const delay of ALERT_RETRY_DELAYS_MS) {
			expect(await processor.processMessages()).toBe(1);
			const [pending] = await allAlerts();
			expect(pending).toMatchObject({ state: "pending", lastError: "database is down" });
			// Redelivered exactly `delay` later: not one millisecond early.
			advance(delay - 1);
			expect(await processor.processMessages()).toBe(0);
			advance(1);
		}
		expect(await processor.processMessages()).toBe(1);

		expect(await allAlerts()).toMatchObject([
			{
				id: alert.id,
				state: "failed",
				attempts: ALERT_MAX_ATTEMPTS,
				lastError: "database is down",
			},
		]);
		expect(errors).toEqual(Array(ALERT_MAX_ATTEMPTS).fill(`alert ${alert.id}`));
		expect(queue.size).toBe(0);
	});

	it("counts attempts that crash before recording an outcome, then gives up", async () => {
		const { alerts, queue, processorWith, send, advance, allAlerts, allIncidents } = setup();
		// Both complete() and fail() throw, so no outcome is recorded and the message is left.
		const crashing = processorWith({
			...throwingComplete(alerts),
			fail: async () => {
				throw new Error("worker died");
			},
		});
		const alert = await send();

		for (let attempt = 1; attempt <= ALERT_MAX_ATTEMPTS; attempt++) {
			expect(await crashing.processMessages()).toBe(1);
			expect((await allAlerts())[0]).toMatchObject({ state: "pending", attempts: attempt });
			advance(VISIBILITY_MS);
		}
		// A healthy worker receives it next, sees every attempt used up, and stops retrying.
		expect(await processorWith().processMessages()).toBe(1);

		expect(await allAlerts()).toMatchObject([
			{ id: alert.id, state: "failed", lastError: expect.stringContaining("Gave up") },
		]);
		expect(await allIncidents()).toEqual([]);
		expect(queue.size).toBe(0);
	});
});

describe("alertProcessor sweeper", () => {
	it("sends an alert that was never sent, 2 minutes after it was due, and marks it sent", async () => {
		const { processor, queue, store, advance, allAlerts, allIncidents } = setup();
		const alert = await store();

		advance(ALERT_UNSENT_RESEND_MS - 1);
		expect(await processor.sweep()).toBe(0);
		advance(1);
		expect(await processor.sweep()).toBe(1);

		expect(queue.size).toBe(1);
		expect((await allAlerts())[0]).toMatchObject({
			id: alert.id,
			sentAt: new Date(alert.receivedAt.getTime() + ALERT_UNSENT_RESEND_MS),
		});
		// Claimed, so the next sweep leaves it alone.
		expect(await processor.sweep()).toBe(0);
		await processor.processMessages();
		expect(await allIncidents()).toMatchObject([{ alertCount: 1 }]);
	});

	it("leaves a sent alert waiting behind a backlog alone for 15 minutes", async () => {
		const { processor, queue, send, advance, allIncidents } = setup();
		await send();

		advance(ALERT_SENT_RESEND_MS - 1);
		expect(await processor.sweep()).toBe(0);
		expect(queue.size).toBe(1);

		// Past the cutoff, the message is presumed lost. The duplicate is harmless.
		advance(1);
		expect(await processor.sweep()).toBe(1);
		expect(queue.size).toBe(2);
		await processor.processMessages();
		expect(await allIncidents()).toMatchObject([{ alertCount: 1 }]);
	});

	it("never re-sends an alert that is in flight or waiting for its backoff", async () => {
		const { alerts, processorWith, send, advance } = setup();
		await send();
		await processorWith(throwingComplete(alerts)).processMessages();

		// The longest backoff is 10 minutes. The sweeper waits 15 past the retry time.
		advance(ALERT_RETRY_DELAYS_MS[0] + ALERT_SENT_RESEND_MS - 1);

		expect(await processorWith().sweep()).toBe(0);
	});

	it("never re-sends a processed or failed alert", async () => {
		const { alerts, processor, send, store, advance } = setup();
		await send();
		await processor.processMessages();
		const failed = await store();
		await alerts.fail(tenant, failed.id, "boom", null, failed.receivedAt);

		advance(24 * 60 * 60 * 1000);

		expect(await processor.sweep()).toBe(0);
	});

	it("tries a failed re-send again on a later sweep", async () => {
		const { processor, queue, store, advance, allAlerts, errors } = setup();
		const alert = await store();
		queue.failSends = true;

		advance(ALERT_UNSENT_RESEND_MS);
		expect(await processor.sweep()).toBe(1);
		expect(errors).toEqual([`alert ${alert.id}`]);
		expect((await allAlerts())[0]).toMatchObject({ sentAt: null });

		queue.failSends = false;
		expect(await processor.sweep()).toBe(0);
		advance(ALERT_UNSENT_RESEND_MS);
		expect(await processor.sweep()).toBe(1);
		expect(queue.size).toBe(1);
	});
});

describe("alertProcessor concurrency", () => {
	it("groups two concurrent workers' alerts for one new key into one incident", async () => {
		const { processorWith, send, allIncidents } = setup();
		await send();
		await send();

		const received = await Promise.all([
			processorWith(undefined, 1).processMessages(),
			processorWith(undefined, 1).processMessages(),
		]);

		expect(received).toEqual([1, 1]);
		expect(await allIncidents()).toMatchObject([{ alertCount: 2 }]);
	});

	it("never groups an alert twice, even when a second copy started its own attempt", async () => {
		const { alerts, store, allIncidents } = setup();
		const alert = await store();
		const started = await alerts.startAttempt(tenant, alert.id, start);

		const first = await alerts.complete(tenant, alert.id, null, start, groupingAudit(tenant));
		const second = await alerts.complete(tenant, alert.id, null, start, groupingAudit(tenant));

		expect(started?.id).toBe(alert.id);
		expect(first).toEqual({ incidentId: null });
		expect(second).toBeNull();
		expect(await alerts.startAttempt(tenant, alert.id, start)).toBeNull();
		expect(await allIncidents()).toEqual([]);
	});
});

// Spec: docs/features/on-call-schedules.md, "Which schedule assigns an incident".
describe("alertProcessor assignment", () => {
	const source = (tenantId: TenantId, onCallScheduleId: string | null) => ({
		id: SOURCE,
		tenantId,
		name: "prometheus",
		secretCiphertext: new Uint8Array(),
		secretHint: "WXYZ",
		onCallScheduleId,
		createdAt: start,
	});

	const assigning = (lookup: AlertSourceLookup) => {
		const context = setup();
		const asked: (string | null)[] = [];
		const onCall: OnCallAssigner = {
			assigneeFor: async (_tenantId, scheduleId) => {
				asked.push(scheduleId);
				return { userId: "user-7", email: "grace@acme.example" };
			},
		};
		const processor = createAlertProcessor({
			queue: context.queue,
			alerts: context.alerts,
			outbox: context.alerts,
			now: () => start,
			sources: lookup,
			onCall,
		});
		return { ...context, processor, asked };
	};

	it("assigns the incident from the source's linked schedule, and audits it", async () => {
		const { processor, send, allIncidents, asked, incidents } = assigning({
			findForIngest: async () => source(tenant, "schedule-1"),
		});
		await send();

		await processor.processMessages();

		const [incident] = await allIncidents();
		expect(asked).toEqual(["schedule-1"]);
		expect(incident).toMatchObject({ assigneeId: "user-7", assignmentCount: 0 });
		const actions = (
			await incidents.audit.listForResource(
				tenant,
				{ type: "incident", id: incident?.id ?? "" },
				{ limit: 10, offset: 0 },
			)
		).items.map((entry) => [entry.action, entry.details]);
		expect(actions).toContainEqual([
			"incident.assigned",
			{ from: "none", to: "user-7", manual: "false" },
		]);
	});

	it("asks for the default schedule when the source is unlinked or not the tenant's", async () => {
		const unlinked = assigning({ findForIngest: async () => source(tenant, null) });
		const foreign = assigning({
			findForIngest: async () => source("tenant-b" as TenantId, "schedule-b"),
		});
		await unlinked.send();
		await foreign.send();

		await unlinked.processor.processMessages();
		await foreign.processor.processMessages();

		expect(unlinked.asked).toEqual([null]);
		expect(foreign.asked).toEqual([null]);
	});

	it("does not change the assignee when an alert joins an open incident", async () => {
		const { processor, send, allIncidents, asked } = assigning({
			findForIngest: async () => source(tenant, null),
		});
		await send();
		await processor.processMessages();
		const [opened] = await allIncidents();

		await send();
		await send({ status: "resolved" });
		await processor.processMessages();

		const [after] = await allIncidents();
		expect(after).toMatchObject({ id: opened?.id, assigneeId: "user-7", alertCount: 3 });
		// A resolved alert cannot open an incident, so it never asks who is on call.
		expect(asked).toHaveLength(2);
	});
});
