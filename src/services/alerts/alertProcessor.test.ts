import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { IncidentId } from "../../contract/incidents";
import type { Alert } from "../../domain/alerts/types";
import type { TenantId } from "../../domain/shared/identity";
import { InMemoryAlertRepository } from "../../repository/alerts/inMemoryAlertRepository";
import { InMemoryIncidentRepository } from "../../repository/incidents/inMemoryIncidentRepository";
import { ALERT_MAX_ATTEMPTS, ALERT_RETRY_DELAYS_MS, createAlertProcessor } from "./alertProcessor";

const tenant = "tenant-a" as TenantId;
const SOURCE = "00000000-0000-4000-8000-000000000001";
const start = new Date("2026-01-01T00:00:00.000Z");

const setup = () => {
	let clock = start.getTime();
	const incidents = new InMemoryIncidentRepository();
	const alerts = new InMemoryAlertRepository(incidents);
	const processor = createAlertProcessor({
		queue: alerts,
		alerts,
		now: () => new Date(clock),
	});
	const advance = (ms: number) => {
		clock += ms;
	};
	const send = (overrides: Partial<Alert> = {}) =>
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
			nextAttemptAt: new Date(clock),
			lastError: null,
			incidentId: null,
			receivedAt: new Date(clock),
			processedAt: null,
			...overrides,
		});
	const allIncidents = async () => (await incidents.list(tenant, { limit: 100, offset: 0 })).items;
	const allAlerts = async () => (await alerts.list(tenant, { limit: 100, offset: 0 })).items;
	return { incidents, alerts, processor, advance, send, allIncidents, allAlerts };
};

describe("alertProcessor grouping", () => {
	it("opens an incident for a new key, with the alert's title and severity", async () => {
		const { processor, send, allIncidents, allAlerts } = setup();
		const alert = await send();

		expect(await processor.processBatch()).toBe(1);

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
		});
		expect(await allAlerts()).toMatchObject([
			{ id: alert.id, state: "processed", incidentId: incident?.id, attempts: 1 },
		]);
	});

	it("attaches a repeat key to the unresolved incident and counts it", async () => {
		const { processor, send, advance, allIncidents } = setup();
		await send();
		advance(1000);
		const repeat = await send({ title: "A different title", severity: "sev1" });

		await processor.processBatch();

		const incidents = await allIncidents();
		expect(incidents).toHaveLength(1);
		// Later alerts never change the title or severity. A person does.
		expect(incidents[0]).toMatchObject({
			title: "DB CPU above 90%",
			severity: "sev2",
			alertCount: 2,
			lastAlertAt: repeat.receivedAt,
		});
	});

	it("attaches to an acknowledged incident without changing its status", async () => {
		const { incidents, processor, send, allIncidents } = setup();
		await send();
		await processor.processBatch();
		const [opened] = await allIncidents();
		await incidents.update(tenant, opened?.id as IncidentId, "open", { status: "acknowledged" });

		await send();
		await processor.processBatch();

		expect(await allIncidents()).toMatchObject([{ status: "acknowledged", alertCount: 2 }]);
	});

	it("opens a new incident when the last one for the key is resolved", async () => {
		const { incidents, processor, send, allIncidents } = setup();
		await send();
		await processor.processBatch();
		const [first] = await allIncidents();
		await incidents.update(tenant, first?.id as IncidentId, "open", { status: "resolved" });

		await send();
		await processor.processBatch();

		const all = await allIncidents();
		expect(all).toHaveLength(2);
		expect(all.filter((incident) => incident.status === "open")).toHaveLength(1);
	});

	it("keeps different keys and different sources apart", async () => {
		const { processor, send, allIncidents } = setup();
		await send();
		await send({ dedupKey: "disk-full" });
		await send({ sourceId: "00000000-0000-4000-8000-000000000002" });

		await processor.processBatch();

		expect(await allIncidents()).toHaveLength(3);
	});

	it("attaches a resolved alert but leaves the incident open", async () => {
		const { processor, send, allIncidents, allAlerts } = setup();
		await send();
		await processor.processBatch();

		await send({ status: "resolved" });
		await processor.processBatch();

		const [incident] = await allIncidents();
		expect(incident).toMatchObject({ status: "open", alertCount: 2 });
		expect((await allAlerts()).every((alert) => alert.incidentId === incident?.id)).toBe(true);
	});

	it("stores a resolved alert with no incident when none is unresolved", async () => {
		const { processor, send, allIncidents, allAlerts } = setup();
		await send({ status: "resolved" });

		await processor.processBatch();

		expect(await allIncidents()).toEqual([]);
		expect(await allAlerts()).toMatchObject([{ state: "processed", incidentId: null }]);
	});

	it("processes alerts oldest first, so a firing alert after a resolved one still opens", async () => {
		const { processor, send, advance, allIncidents } = setup();
		await send({ status: "resolved" });
		advance(1000);
		await send();

		await processor.processBatch();

		expect(await allIncidents()).toMatchObject([{ status: "open", alertCount: 1 }]);
	});

	it("skips alerts that are not yet due, and claims nothing when idle", async () => {
		const { processor, send, advance } = setup();
		await send({ nextAttemptAt: new Date(start.getTime() + 10_000) });

		expect(await processor.processBatch()).toBe(0);
		advance(10_000);
		expect(await processor.processBatch()).toBe(1);
		expect(await processor.processBatch()).toBe(0);
	});
});

describe("alertProcessor failures", () => {
	const failingSetup = () => {
		const ctx = setup();
		const errors: string[] = [];
		let clock = start.getTime();
		const processor = createAlertProcessor({
			queue: ctx.alerts,
			alerts: {
				enqueue: ctx.alerts.enqueue.bind(ctx.alerts),
				list: ctx.alerts.list.bind(ctx.alerts),
				fail: ctx.alerts.fail.bind(ctx.alerts),
				complete: async () => {
					throw new Error("database is down");
				},
			},
			now: () => new Date(clock),
			onError: (alertId) => errors.push(alertId),
		});
		const advance = (ms: number) => {
			clock += ms;
		};
		return { ...ctx, processor, advance, errors };
	};

	it("retries with backoff, then marks the alert failed after the last attempt", async () => {
		const { processor, send, advance, allAlerts, errors } = failingSetup();
		const alert = await send();

		for (const delay of ALERT_RETRY_DELAYS_MS) {
			expect(await processor.processBatch()).toBe(1);
			const [pending] = await allAlerts();
			expect(pending).toMatchObject({ state: "pending", lastError: "database is down" });
			// Due exactly `delay` later: not one millisecond early.
			advance(delay - 1);
			expect(await processor.processBatch()).toBe(0);
			advance(1);
		}
		expect(await processor.processBatch()).toBe(1);

		expect(await allAlerts()).toMatchObject([
			{
				id: alert.id,
				state: "failed",
				attempts: ALERT_MAX_ATTEMPTS,
				lastError: "database is down",
			},
		]);
		expect(errors).toHaveLength(ALERT_MAX_ATTEMPTS);
		advance(24 * 60 * 60 * 1000);
		expect(await processor.processBatch()).toBe(0);
	});
});

describe("alertProcessor concurrency", () => {
	it("groups two concurrent workers' alerts for one new key into one incident", async () => {
		const { alerts, send, allIncidents } = setup();
		await send();
		await send();
		const worker = () =>
			createAlertProcessor({ queue: alerts, alerts, now: () => start, batchSize: 1 });

		const claimed = await Promise.all([worker().processBatch(), worker().processBatch()]);

		expect(claimed).toEqual([1, 1]);
		expect(await allIncidents()).toMatchObject([{ alertCount: 2 }]);
	});

	it("never groups an alert twice, even when its lease expired and another worker took it", async () => {
		const { alerts, send, allIncidents } = setup();
		const alert = await send();
		const [claimed] = await alerts.claimDue(start, 1, start);

		const first = await alerts.complete(tenant, alert.id, null, start);
		const second = await alerts.complete(tenant, alert.id, null, start);

		expect(claimed?.id).toBe(alert.id);
		expect(first).toEqual({ incidentId: null });
		expect(second).toBeNull();
		expect(await allIncidents()).toEqual([]);
	});
});
