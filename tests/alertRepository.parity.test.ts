import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAesGcmSecretBox } from "../src/adapters/aesGcmSecretBox";
import { InMemoryAlertQueue } from "../src/adapters/inMemoryAlertQueue";
import type { IncidentId } from "../src/contract/incidents";
import {
	type Alert,
	type AlertOutbox,
	type AlertRepository,
	type AlertSource,
	type AlertSourceLookup,
	type AlertSourceRepository,
	alertSourceSecretContext,
} from "../src/domain/alerts/types";
import type { Incident, IncidentRepository } from "../src/domain/incidents/types";
import type { Principal, TenantId } from "../src/domain/shared/identity";
import { InMemoryAlertRepository } from "../src/repository/alerts/inMemoryAlertRepository";
import { InMemoryAlertSourceRepository } from "../src/repository/alerts/inMemoryAlertSourceRepository";
import { PostgresAlertRepository } from "../src/repository/alerts/postgresAlertRepository";
import { PostgresAlertSourceRepository } from "../src/repository/alerts/postgresAlertSourceRepository";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { PostgresIncidentRepository } from "../src/repository/incidents/postgresIncidentRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { createAlertProcessor } from "../src/services/alerts/alertProcessor";
import { createAlertSourceService } from "../src/services/alerts/alertSourceService";
import { anAudit, groupingAudit } from "./auditEntries";

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema, so other parity tests' TRUNCATEs, which run in parallel, never touch these rows.
const SCHEMA = "alert_parity";
const admin = new Pool({ connectionString: TEST_DATABASE_URL });
const pool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${SCHEMA}` });

beforeAll(async () => {
	try {
		await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
		await admin.query(`CREATE SCHEMA ${SCHEMA}`);
		await runMigrations(pool);
	} catch (error) {
		throw new Error(
			`Cannot reach the test database at ${new URL(TEST_DATABASE_URL).host}. Run: pnpm db:up`,
			{ cause: error },
		);
	}
});

// claimOverdue serves every tenant, so alerts left by an earlier test would be claimed by a later one.
// This schema belongs to this file alone, so emptying it is safe.
beforeEach(async () => {
	await pool.query("TRUNCATE alerts");
});

afterAll(async () => {
	await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
	await Promise.all([admin.end(), pool.end()]);
});

// Real tenants, because alert_sources references tenants.
const newTenant = async (): Promise<TenantId> => {
	const id = randomUUID() as TenantId;
	await pool.query("INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, now())", [
		id,
		"Acme",
	]);
	return id;
};

const newSource = (
	name: string,
	createdAt = new Date("2026-01-01T00:00:00.123Z"),
): Omit<AlertSource, "tenantId"> => ({
	id: randomUUID(),
	name,
	secretCiphertext: Buffer.from([1, 2, 3, 4]),
	secretHint: "WXYZ",
	createdAt,
});

type Stores = {
	sources: AlertSourceRepository & AlertSourceLookup;
	alerts: AlertRepository & AlertOutbox;
	incidents: IncidentRepository;
};

describe.each([
	[
		"in-memory",
		(): Stores => {
			const incidents = new InMemoryIncidentRepository();
			return {
				sources: new InMemoryAlertSourceRepository(),
				alerts: new InMemoryAlertRepository(incidents),
				incidents,
			};
		},
	],
	[
		"postgres",
		(): Stores => ({
			sources: new PostgresAlertSourceRepository(pool),
			alerts: new PostgresAlertRepository(pool),
			incidents: new PostgresIncidentRepository(pool),
		}),
	],
] as const)("alert repositories parity: %s", (_name, make) => {
	let stores: Stores;
	let acme: TenantId;
	let globex: TenantId;
	let source: AlertSource;
	let clock: number;

	beforeEach(async () => {
		stores = make();
		acme = await newTenant();
		globex = await newTenant();
		source = (await stores.sources.create(
			acme,
			newSource("prometheus"),
			anAudit(acme),
		)) as AlertSource;
		clock = Date.parse("2030-01-01T00:00:00Z");
	});

	const at = (offsetMs = 0) => new Date(clock + offsetMs);

	const newAlert = (overrides: Partial<Alert> = {}): Omit<Alert, "tenantId"> => ({
		id: randomUUID(),
		sourceId: source.id,
		dedupKey: `key-${randomUUID()}`,
		status: "firing",
		title: "DB CPU above 90%",
		severity: "sev2",
		details: { host: "db-1", cpu: 97, paged: true },
		state: "pending",
		attempts: 0,
		nextAttemptAt: at(),
		lastError: null,
		incidentId: null,
		receivedAt: at(),
		processedAt: null,
		sentAt: null,
		...overrides,
	});

	// Unsent alerts due by at(0) and sent ones due by at(-10_000) are overdue.
	const claimOverdue = () =>
		stores.alerts.claimOverdue({ unsentBefore: at(), sentBefore: at(-10_000) }, at(60_000), 100);
	const stored = async (tenantId = acme) =>
		(await stores.alerts.list(tenantId, { limit: 10, offset: 0 })).items;

	const candidate = (alert: Omit<Alert, "tenantId">): Omit<Incident, "tenantId"> => ({
		id: randomUUID() as IncidentId,
		title: alert.title,
		severity: alert.severity,
		status: "open",
		createdAt: at(),
		createdBy: `alert_source:${alert.sourceId}`,
		acknowledgedAt: null,
		acknowledgedBy: null,
		resolvedAt: null,
		resolvedBy: null,
		alertSourceId: alert.sourceId,
		dedupKey: alert.dedupKey,
		alertCount: 1,
		lastAlertAt: alert.receivedAt,
	});

	describe("sources", () => {
		it("round-trips every field, by tenant and by id", async () => {
			const input = newSource("grafana");

			const created = await stores.sources.create(acme, input, anAudit(acme));

			expect(created).toEqual({ ...input, tenantId: acme });
			expect(await stores.sources.findForIngest(input.id)).toEqual(created);
			expect(await stores.sources.findForIngest(randomUUID())).toBeNull();
		});

		it("refuses a duplicate name in the same tenant, but allows it in another", async () => {
			expect(await stores.sources.create(acme, newSource("prometheus"), anAudit(acme))).toBeNull();
			expect(
				await stores.sources.create(globex, newSource("prometheus"), anAudit(globex)),
			).not.toBeNull();
		});

		it("lists only the tenant's sources, oldest first, with a total", async () => {
			await stores.sources.create(
				acme,
				newSource("a", new Date("2025-12-31T00:00:00Z")),
				anAudit(acme),
			);
			await stores.sources.create(globex, newSource("other"), anAudit(globex));

			const page = await stores.sources.list(acme, { limit: 1, offset: 0 });

			expect(page.total).toBe(2);
			expect(page.items.map((item) => item.name)).toEqual(["a"]);
		});
	});

	describe("alerts", () => {
		it("round-trips every field and lists only the tenant's alerts, newest first", async () => {
			const older = newAlert();
			const newer = newAlert({ receivedAt: at(1000) });
			const created = await stores.alerts.enqueue(acme, older);
			await stores.alerts.enqueue(acme, newer);

			expect(created).toEqual({ ...older, tenantId: acme });
			const page = await stores.alerts.list(acme, { limit: 10, offset: 0 });
			expect(page.items.map((item) => item.id)).toEqual([newer.id, older.id]);
			expect((await stores.alerts.list(globex, { limit: 10, offset: 0 })).total).toBe(0);
		});

		it("filters the list by state", async () => {
			const pending = newAlert();
			await stores.alerts.enqueue(acme, pending);

			expect(
				(await stores.alerts.list(acme, { limit: 10, offset: 0, state: "pending" })).total,
			).toBe(1);
			expect(
				(await stores.alerts.list(acme, { limit: 10, offset: 0, state: "failed" })).total,
			).toBe(0);
		});

		it("records a send, for the alert's own tenant only", async () => {
			const alert = newAlert();
			await stores.alerts.enqueue(acme, alert);

			await stores.alerts.markSent(globex, alert.id, at(1));
			expect((await stored())[0]?.sentAt).toBeNull();
			await stores.alerts.markSent(acme, alert.id, at(2));
			expect((await stored())[0]?.sentAt).toEqual(at(2));
		});

		it("starts an attempt only on the tenant's pending alert, and leases it", async () => {
			const alert = newAlert();
			await stores.alerts.enqueue(acme, alert);

			expect(await stores.alerts.startAttempt(globex, alert.id, at(60_000))).toBeNull();
			expect(await stores.alerts.startAttempt(acme, randomUUID(), at(60_000))).toBeNull();
			const started = await stores.alerts.startAttempt(acme, alert.id, at(60_000));
			expect(started).toEqual({ ...alert, tenantId: acme, attempts: 1, nextAttemptAt: at(60_000) });
			expect((await stores.alerts.startAttempt(acme, alert.id, at(70_000)))?.attempts).toBe(2);

			await stores.alerts.complete(acme, alert.id, null, at(), groupingAudit(acme));
			expect(await stores.alerts.startAttempt(acme, alert.id, at(80_000))).toBeNull();
			expect((await stored())[0]?.attempts).toBe(2);
		});

		it("claims overdue alerts oldest first, with a longer cutoff once sent, across tenants", async () => {
			const second = newAlert({ receivedAt: at(500) });
			const first = newAlert();
			const otherTenant = newAlert({ receivedAt: at(700) });
			const sentLongAgo = newAlert({
				receivedAt: at(900),
				nextAttemptAt: at(-10_000),
				sentAt: at(-10_000),
			});
			const sentRecently = newAlert({ nextAttemptAt: at(-9_999), sentAt: at(-9_999) });
			const notDue = newAlert({ nextAttemptAt: at(1) });
			for (const alert of [second, first, sentLongAgo, sentRecently, notDue]) {
				await stores.alerts.enqueue(acme, alert);
			}
			const globexSource = (await stores.sources.create(
				globex,
				newSource("prometheus"),
				anAudit(globex),
			)) as AlertSource;
			await stores.alerts.enqueue(globex, { ...otherTenant, sourceId: globexSource.id });

			const claimed = await claimOverdue();

			expect(claimed).toEqual([
				{ tenantId: acme, alertId: first.id },
				{ tenantId: acme, alertId: second.id },
				{ tenantId: globex, alertId: otherTenant.id },
				{ tenantId: acme, alertId: sentLongAgo.id },
			]);
			const byId = new Map((await stored()).map((alert) => [alert.id, alert]));
			expect(byId.get(first.id)).toMatchObject({ nextAttemptAt: at(60_000), attempts: 0 });
			expect(byId.get(sentRecently.id)?.nextAttemptAt).toEqual(at(-9_999));
			expect(await claimOverdue()).toEqual([]);
		});

		it("never claims a processed or failed alert", async () => {
			const processed = newAlert();
			const failed = newAlert();
			await stores.alerts.enqueue(acme, processed);
			await stores.alerts.enqueue(acme, failed);
			await stores.alerts.complete(acme, processed.id, null, at(), groupingAudit(acme));
			await stores.alerts.fail(acme, failed.id, "boom", null, at());

			expect(await claimOverdue()).toEqual([]);
		});

		it("opens an incident for a new key, then attaches the next alert to it", async () => {
			const first = newAlert();
			const second = newAlert({ dedupKey: first.dedupKey, receivedAt: at(2000) });
			await stores.alerts.enqueue(acme, first);
			await stores.alerts.enqueue(acme, second);

			const opened = await stores.alerts.complete(
				acme,
				first.id,
				candidate(first),
				at(5),
				groupingAudit(acme),
			);
			const attached = await stores.alerts.complete(
				acme,
				second.id,
				candidate(second),
				at(6),
				groupingAudit(acme),
			);

			expect(attached?.incidentId).toBe(opened?.incidentId);
			const incident = await stores.incidents.findById(acme, opened?.incidentId as IncidentId);
			expect(incident).toMatchObject({
				alertSourceId: source.id,
				dedupKey: first.dedupKey,
				alertCount: 2,
				lastAlertAt: at(2000),
			});
			const page = await stores.alerts.list(acme, { limit: 10, offset: 0 });
			expect(page.items.every((alert) => alert.state === "processed")).toBe(true);
			expect(page.items.map((alert) => alert.processedAt)).toEqual([at(6), at(5)]);
		});

		it("never moves lastAlertAt backwards for a late, older alert", async () => {
			const newer = newAlert({ receivedAt: at(5000) });
			const older = newAlert({ dedupKey: newer.dedupKey });
			await stores.alerts.enqueue(acme, newer);
			await stores.alerts.enqueue(acme, older);

			const { incidentId } =
				(await stores.alerts.complete(
					acme,
					newer.id,
					candidate(newer),
					at(),
					groupingAudit(acme),
				)) ?? {};
			await stores.alerts.complete(acme, older.id, candidate(older), at(), groupingAudit(acme));

			const incident = await stores.incidents.findById(acme, incidentId as IncidentId);
			expect(incident?.lastAlertAt).toEqual(at(5000));
		});

		it("attaches without a candidate only when an unresolved incident exists", async () => {
			const lonely = newAlert({ status: "resolved" });
			await stores.alerts.enqueue(acme, lonely);

			expect(
				await stores.alerts.complete(acme, lonely.id, null, at(), groupingAudit(acme)),
			).toEqual({
				incidentId: null,
			});
		});

		it("opens a new incident once the previous one for the key is resolved", async () => {
			const first = newAlert();
			const second = newAlert({ dedupKey: first.dedupKey });
			await stores.alerts.enqueue(acme, first);
			await stores.alerts.enqueue(acme, second);
			const opened = await stores.alerts.complete(
				acme,
				first.id,
				candidate(first),
				at(),
				groupingAudit(acme),
			);
			await stores.incidents.update(
				acme,
				opened?.incidentId as IncidentId,
				"open",
				{
					status: "resolved",
				},
				anAudit(acme, "incident.acknowledged"),
			);

			const reopened = await stores.alerts.complete(
				acme,
				second.id,
				candidate(second),
				at(),
				groupingAudit(acme),
			);

			expect(reopened?.incidentId).not.toBe(opened?.incidentId);
		});

		it("completes an alert only once", async () => {
			const alert = newAlert();
			await stores.alerts.enqueue(acme, alert);

			const first = await stores.alerts.complete(
				acme,
				alert.id,
				candidate(alert),
				at(),
				groupingAudit(acme),
			);
			const second = await stores.alerts.complete(
				acme,
				alert.id,
				candidate(alert),
				at(),
				groupingAudit(acme),
			);

			expect(first?.incidentId).not.toBeNull();
			expect(second).toBeNull();
			const incident = await stores.incidents.findById(acme, first?.incidentId as IncidentId);
			expect(incident?.alertCount).toBe(1);
		});

		it("ignores another tenant's id in complete and fail", async () => {
			const alert = newAlert();
			await stores.alerts.enqueue(acme, alert);

			expect(
				await stores.alerts.complete(
					globex,
					alert.id,
					candidate(alert),
					at(),
					groupingAudit(globex),
				),
			).toBeNull();
			await stores.alerts.fail(globex, alert.id, "boom", null, at());

			expect((await stores.alerts.list(acme, { limit: 10, offset: 0 })).items[0]).toMatchObject({
				state: "pending",
				lastError: null,
			});
		});

		it("records a retry, then a final failure", async () => {
			const alert = newAlert();
			await stores.alerts.enqueue(acme, alert);

			await stores.alerts.fail(acme, alert.id, "first", at(5000), at());
			const [retrying] = (await stores.alerts.list(acme, { limit: 10, offset: 0 })).items;
			await stores.alerts.fail(acme, alert.id, "last", null, at(9000));
			const [failed] = (await stores.alerts.list(acme, { limit: 10, offset: 0 })).items;

			expect(retrying).toMatchObject({
				state: "pending",
				lastError: "first",
				nextAttemptAt: at(5000),
				processedAt: null,
			});
			expect(failed).toMatchObject({ state: "failed", lastError: "last", processedAt: at(9000) });
		});
	});
});

describe("alert grouping races in postgres", () => {
	it("gives concurrent workers that see one new key a single incident", async () => {
		const tenantId = await newTenant();
		const sources = new PostgresAlertSourceRepository(pool);
		const alerts = new PostgresAlertRepository(pool);
		const source = (await sources.create(
			tenantId,
			newSource("prometheus"),
			anAudit(tenantId),
		)) as AlertSource;
		const now = new Date("2030-01-01T00:00:00Z");
		const dedupKey = `race-${randomUUID()}`;
		const count = 8;
		for (let i = 0; i < count; i++) {
			await alerts.enqueue(tenantId, {
				id: randomUUID(),
				sourceId: source.id,
				dedupKey,
				status: "firing",
				title: "DB CPU above 90%",
				severity: "sev2",
				details: {},
				state: "pending",
				attempts: 0,
				nextAttemptAt: now,
				lastError: null,
				incidentId: null,
				receivedAt: now,
				processedAt: null,
				sentAt: null,
			});
		}
		const queue = new InMemoryAlertQueue({ now: () => now });
		for (const { id } of (await alerts.list(tenantId, { limit: count, offset: 0 })).items) {
			await queue.send({ tenantId, alertId: id });
		}
		const worker = () =>
			createAlertProcessor({ queue, alerts, outbox: alerts, now: () => now, batchSize: 1 });

		const claimed = await Promise.all(
			Array.from({ length: count }, () => worker().processMessages()),
		);

		expect(claimed.reduce((sum, n) => sum + n, 0)).toBe(count);
		const { rows } = await pool.query<{ alert_count: number }>(
			"SELECT alert_count FROM incidents WHERE tenant_id = $1 AND dedup_key = $2",
			[tenantId, dedupKey],
		);
		expect(rows).toEqual([{ alert_count: count }]);
	});
});

describe("alert source storage in postgres", () => {
	it("stores only ciphertext, which opens only under its own tenant and source", async () => {
		const box = createAesGcmSecretBox(Buffer.alloc(32, 5).toString("base64"));
		const tenantId = await newTenant();
		const principal: Principal = { tenantId, userId: "user-1", role: "admin" };
		const service = createAlertSourceService(new PostgresAlertSourceRepository(pool), box);

		const created = await service.create(principal, { name: "prometheus" });
		if (!created.ok) throw new Error("create failed");
		const { source, secret } = created.value;

		const { rows } = await pool.query<{ secret_ciphertext: Buffer }>(
			"SELECT secret_ciphertext FROM alert_sources WHERE tenant_id = $1",
			[tenantId],
		);
		const raw = rows[0]?.secret_ciphertext ?? Buffer.alloc(0);

		expect(raw.includes(secret)).toBe(false);
		expect(box.open(raw, alertSourceSecretContext(tenantId, source.id))).toBe(secret);
		expect(() =>
			box.open(raw, alertSourceSecretContext(randomUUID() as TenantId, source.id)),
		).toThrow();
		// A notification channel's context cannot open it either.
		expect(() => box.open(raw, `notification_channel:${tenantId}:${source.id}`)).toThrow();
	});
});
