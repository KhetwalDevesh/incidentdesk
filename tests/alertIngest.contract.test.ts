import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { signAlertBody } from "../src/adapters/hmacAlertSignature";
import {
	ALERT_MAX_BODY_BYTES,
	ALERT_SIGNATURE_HEADER,
	ALERT_TIMESTAMP_HEADER,
	AlertAcceptedSchema,
	AlertListSchema,
} from "../src/contract/alerts";
import { ProblemSchema } from "../src/contract/common";
import { IncidentListSchema } from "../src/contract/incidents";
import type { TenantId } from "../src/domain/shared/identity";
import { addAlertSource, authed, buildTestSystem, signedAlert } from "./helpers";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const NOW_SECONDS = String(NOW.getTime() / 1000);
const alert = { dedupKey: "db-cpu-high", title: "DB CPU above 90%", severity: "sev2" };
// The tenant behind the fixed "acme-admin" token.
const ACME = "tenant-acme" as TenantId;

describe("alert webhook contract", () => {
	let system: ReturnType<typeof buildTestSystem>;
	let path: string;
	let secret: string;

	beforeEach(async () => {
		system = buildTestSystem({ alertNow: () => NOW });
		const source = await addAlertSource(system.app, "acme-admin");
		path = `/webhooks/alerts/${source.sourceId}`;
		secret = source.secret;
	});

	const send = (body: unknown, timestamp = NOW_SECONDS, key = secret) =>
		system.app.request(path, signedAlert(key, body, timestamp));

	it("accepts a signed alert with 202 and queues it as pending", async () => {
		const res = await send(alert);

		expect(res.status).toBe(202);
		const { alertId } = AlertAcceptedSchema.parse(await res.json());
		const listed = await system.app.request("/v1/alerts", authed("acme-admin"));
		expect(AlertListSchema.parse(await listed.json()).items).toMatchObject([
			{
				id: alertId,
				state: "pending",
				status: "firing",
				attempts: 0,
				incidentId: null,
				details: {},
			},
		]);
	});

	it("sends only the tenant and alert ids to the queue, and records the send", async () => {
		const res = await send({ ...alert, details: { host: "db-1" } });

		const { alertId } = AlertAcceptedSchema.parse(await res.json());
		const [message] = await system.queue.receive(10, 0);
		expect(JSON.parse(message?.body ?? "null")).toEqual({ tenantId: ACME, alertId });
		const [stored] = (await system.alerts.list(ACME, { limit: 10, offset: 0 })).items;
		expect(stored).toMatchObject({ id: alertId, state: "pending", sentAt: NOW });
	});

	it("still returns 202 and keeps the alert pending and unsent when the queue is down", async () => {
		system.queue.failSends = true;

		const res = await send(alert);

		expect(res.status).toBe(202);
		const { alertId } = AlertAcceptedSchema.parse(await res.json());
		expect(system.queue.size).toBe(0);
		const [stored] = (await system.alerts.list(ACME, { limit: 10, offset: 0 })).items;
		expect(stored).toMatchObject({ id: alertId, state: "pending", sentAt: null });
	});

	it("needs no bearer token", async () => {
		const res = await send(alert);

		expect(res.status).toBe(202);
	});

	it("opens an incident only once the worker runs", async () => {
		await send(alert);
		const before = await system.app.request("/v1/incidents", authed("acme-viewer"));
		expect(IncidentListSchema.parse(await before.json()).total).toBe(0);

		await system.processor.processMessages();

		const after = await system.app.request("/v1/incidents", authed("acme-viewer"));
		expect(IncidentListSchema.parse(await after.json()).items).toMatchObject([
			{
				title: "DB CPU above 90%",
				severity: "sev2",
				status: "open",
				origin: "alert",
				alertCount: 1,
				lastAlertAt: NOW.toISOString(),
			},
		]);
	});

	it("groups repeated alerts into one incident", async () => {
		for (let i = 0; i < 3; i++) await send(alert);

		await system.processor.processMessages();

		const res = await system.app.request("/v1/incidents", authed("acme-viewer"));
		const page = IncidentListSchema.parse(await res.json());
		expect(page.total).toBe(1);
		expect(page.items[0]?.alertCount).toBe(3);
	});

	it("accepts details and a timestamp up to 300 seconds off", async () => {
		const withDetails = { ...alert, status: "resolved", details: { host: "db-1", cpu: 97 } };

		expect((await send(withDetails, String(Number(NOW_SECONDS) - 300))).status).toBe(202);
		expect((await send(alert, String(Number(NOW_SECONDS) + 300))).status).toBe(202);
	});

	it("returns an identical 401 for every authentication failure", async () => {
		const raw = JSON.stringify(alert);
		const requests: [string, RequestInit][] = [
			[`/webhooks/alerts/${randomUUID()}`, signedAlert(secret, alert, NOW_SECONDS)],
			["/webhooks/alerts/not-a-uuid", signedAlert(secret, alert, NOW_SECONDS)],
			[path, signedAlert("wrong-secret", alert, NOW_SECONDS)],
			[path, signedAlert(secret, alert, String(Number(NOW_SECONDS) - 301))],
			[path, signedAlert(secret, alert, String(Number(NOW_SECONDS) + 301))],
			[path, { method: "POST", body: raw }],
			[path, { method: "POST", body: raw, headers: { [ALERT_TIMESTAMP_HEADER]: NOW_SECONDS } }],
			[
				path,
				{
					method: "POST",
					body: raw,
					headers: {
						[ALERT_TIMESTAMP_HEADER]: "not-a-number",
						[ALERT_SIGNATURE_HEADER]: signAlertBody(secret, "not-a-number", raw),
					},
				},
			],
			[
				path,
				{
					method: "POST",
					body: raw,
					headers: { [ALERT_TIMESTAMP_HEADER]: NOW_SECONDS, [ALERT_SIGNATURE_HEADER]: "v1=abc" },
				},
			],
			// Signed over one body, sent with another.
			[
				path,
				{
					method: "POST",
					body: JSON.stringify({ ...alert, severity: "sev1" }),
					headers: {
						[ALERT_TIMESTAMP_HEADER]: NOW_SECONDS,
						[ALERT_SIGNATURE_HEADER]: signAlertBody(secret, NOW_SECONDS, raw),
					},
				},
			],
		];

		const bodies = new Set<string>();
		for (const [url, init] of requests) {
			const res = await system.app.request(url, init);
			expect(res.status).toBe(401);
			const { requestId: _requestId, ...problem } = ProblemSchema.parse(await res.json());
			expect(problem.code).toBe("UNAUTHENTICATED");
			bodies.add(JSON.stringify(problem));
		}
		expect(bodies.size).toBe(1);
		const listed = await system.app.request("/v1/alerts", authed("acme-admin"));
		expect(AlertListSchema.parse(await listed.json()).total).toBe(0);
	});

	it("returns 413 for a body over 64 KB", async () => {
		const big = { ...alert, details: { blob: "x".repeat(ALERT_MAX_BODY_BYTES) } };

		const res = await send(big);

		expect(res.status).toBe(413);
		expect(ProblemSchema.parse(await res.json()).code).toBe("PAYLOAD_TOO_LARGE");
	});

	it.each([
		["invalid JSON", "{not json"],
		["missing dedupKey", { title: alert.title, severity: "sev2" }],
		["empty dedupKey", { ...alert, dedupKey: "" }],
		["short title", { ...alert, title: "ab" }],
		["bad severity", { ...alert, severity: "sev9" }],
		["bad status", { ...alert, status: "acknowledged" }],
		["nested details", { ...alert, details: { nested: { a: 1 } } }],
		[
			"too many details",
			{ ...alert, details: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i])) },
		],
		["unknown field", { ...alert, tenantId: "tenant-globex" }],
	])("returns 422 for a signed body with %s", async (_name, body) => {
		const res = await send(body);

		expect(res.status).toBe(422);
		expect(ProblemSchema.parse(await res.json()).code).toBe("VALIDATION_FAILED");
	});
});
