import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncidentId } from "../src/contract/incidents";
import type { AuditEventReader, AuditPurger, AuditRecorder } from "../src/domain/audit/types";
import type { Incident, IncidentRepository } from "../src/domain/incidents/types";
import type { TenantId } from "../src/domain/shared/identity";
import { InMemoryAuditStore } from "../src/repository/audit/inMemoryAuditStore";
import { PostgresAuditRepository } from "../src/repository/audit/postgresAuditRepository";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { PostgresIncidentRepository } from "../src/repository/incidents/postgresIncidentRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { anAudit } from "./auditEntries";

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema, so other parity tests' TRUNCATEs, which run in parallel, never touch these rows.
const SCHEMA = "audit_parity";
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

// The purge spans every tenant, so this file empties its own schema before each test.
beforeEach(async () => {
	await pool.query("TRUNCATE audit_events, incidents");
});

afterAll(async () => {
	await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
	await Promise.all([admin.end(), pool.end()]);
});

const DAY_MS = 24 * 60 * 60 * 1000;
const acme = "tenant-acme" as TenantId;
const globex = "tenant-globex" as TenantId;

const newIncident = (): Omit<Incident, "tenantId"> => ({
	id: randomUUID() as IncidentId,
	title: "Checkout is down",
	severity: "sev2",
	status: "open",
	createdAt: new Date(),
	createdBy: "user-1",
	acknowledgedAt: null,
	acknowledgedBy: null,
	resolvedAt: null,
	resolvedBy: null,
	alertSourceId: null,
	dedupKey: null,
	alertCount: 0,
	lastAlertAt: null,
});

type Stores = {
	audit: AuditEventReader & AuditRecorder & AuditPurger;
	incidents: IncidentRepository;
};

describe.each([
	[
		"in-memory",
		(): Stores => {
			const audit = new InMemoryAuditStore();
			return { audit, incidents: new InMemoryIncidentRepository(audit) };
		},
	],
	[
		"postgres",
		(): Stores => ({
			audit: new PostgresAuditRepository(pool),
			incidents: new PostgresIncidentRepository(pool),
		}),
	],
] as const)("audit repositories parity: %s", (_name, make) => {
	let stores: Stores;
	// Recent enough that the trigger lets nothing be deleted, and fixed so order is exact.
	const base = Date.now() - DAY_MS;
	const at = (offsetMs: number) => new Date(base + offsetMs);
	const page = { limit: 10, offset: 0 };

	beforeEach(() => {
		stores = make();
	});

	it("round-trips every field, including an anonymous actor", async () => {
		const entry = anAudit(acme, "user.login_failed", {
			occurredAt: at(0),
			actor: { type: "anonymous", id: null },
			resource: { type: "user", id: "user-7" },
			details: {},
			requestId: "req-12345678",
		});
		const withDetails = anAudit(acme, "incident.created", {
			occurredAt: at(1),
			details: { title: "DB CPU above 90%", severity: "sev2" },
		});

		await stores.audit.record(entry);
		await stores.audit.record(withDetails);

		expect((await stores.audit.list(acme, {}, page)).items).toEqual([withDetails, entry]);
	});

	it("lists newest first with a total, and pages", async () => {
		const entries = [0, 1, 2].map((n) => anAudit(acme, "incident.created", { occurredAt: at(n) }));
		for (const entry of entries) await stores.audit.record(entry);
		await stores.audit.record(anAudit(globex, "incident.created", { occurredAt: at(5) }));

		const first = await stores.audit.list(acme, {}, { limit: 2, offset: 0 });
		const second = await stores.audit.list(acme, {}, { limit: 2, offset: 2 });

		expect(first.total).toBe(3);
		expect(first.items.map((entry) => entry.id)).toEqual([entries[2]?.id, entries[1]?.id]);
		expect(second.items.map((entry) => entry.id)).toEqual([entries[0]?.id]);
	});

	it("filters by action, resource, actor and an inclusive time range", async () => {
		const incidentId = randomUUID();
		const created = anAudit(acme, "incident.created", {
			occurredAt: at(0),
			resource: { type: "incident", id: incidentId },
		});
		const acknowledged = anAudit(acme, "incident.acknowledged", {
			occurredAt: at(10),
			actor: { type: "user", id: "user-2" },
			resource: { type: "incident", id: incidentId },
		});
		const other = anAudit(acme, "alert_source.created", {
			occurredAt: at(20),
			resource: { type: "alert_source", id: "src-1" },
		});
		for (const entry of [created, acknowledged, other]) await stores.audit.record(entry);
		const ids = async (filter: Parameters<AuditEventReader["list"]>[1]) =>
			(await stores.audit.list(acme, filter, page)).items.map((entry) => entry.id);

		expect(await ids({ action: "incident.acknowledged" })).toEqual([acknowledged.id]);
		expect(await ids({ resourceType: "incident", resourceId: incidentId })).toEqual([
			acknowledged.id,
			created.id,
		]);
		expect(await ids({ actorId: "user-2" })).toEqual([acknowledged.id]);
		expect(await ids({ from: at(10), to: at(20) })).toEqual([other.id, acknowledged.id]);
		expect(await ids({ from: at(11), to: at(19) })).toEqual([]);
	});

	it("gives a resource's timeline oldest first, in write order within one instant", async () => {
		const resource = { type: "incident", id: randomUUID() } as const;
		const opened = anAudit(acme, "incident.created", { occurredAt: at(0), resource });
		const grouped = anAudit(acme, "alert.grouped", { occurredAt: at(0), resource });
		const resolved = anAudit(acme, "incident.resolved", { occurredAt: at(5), resource });
		for (const entry of [opened, grouped, resolved]) await stores.audit.record(entry);
		await stores.audit.record(anAudit(globex, "incident.created", { occurredAt: at(1), resource }));

		const timeline = await stores.audit.listForResource(acme, resource, page);

		expect(timeline.total).toBe(3);
		expect(timeline.items.map((entry) => entry.action)).toEqual([
			"incident.created",
			"alert.grouped",
			"incident.resolved",
		]);
	});

	it("writes a change's entry with it, and rolls the change back if the entry is refused", async () => {
		const taken = anAudit(acme, "incident.created");
		await stores.audit.record(taken);
		const incident = newIncident();

		// Same tenant and id as a stored entry: the audit_events primary key refuses it.
		await expect(stores.incidents.create(acme, incident, { ...taken })).rejects.toThrow();

		expect(await stores.incidents.findById(acme, incident.id)).toBeNull();
		expect((await stores.audit.list(acme, {}, page)).total).toBe(1);
	});

	it("writes no entry when a compare-and-set update does not apply", async () => {
		const incident = newIncident();
		await stores.incidents.create(acme, incident, anAudit(acme, "incident.created"));

		const won = await stores.incidents.update(
			acme,
			incident.id,
			"open",
			{ status: "acknowledged" },
			anAudit(acme, "incident.acknowledged"),
		);
		const lost = await stores.incidents.update(
			acme,
			incident.id,
			"open",
			{ status: "acknowledged" },
			anAudit(acme, "incident.acknowledged"),
		);

		expect(won).not.toBeNull();
		expect(lost).toBeNull();
		const actions = (await stores.audit.list(acme, {}, page)).items.map((entry) => entry.action);
		expect(actions.sort()).toEqual(["incident.acknowledged", "incident.created"]);
	});

	it("purges only entries older than the cutoff, across tenants, in batches", async () => {
		const old = [acme, globex, acme].map((tenantId, n) =>
			anAudit(tenantId, "incident.created", {
				occurredAt: new Date(Date.now() - (100 + n) * DAY_MS),
			}),
		);
		const recent = anAudit(acme, "incident.created", { occurredAt: at(0) });
		for (const entry of [...old, recent]) await stores.audit.record(entry);
		const cutoff = new Date(Date.now() - 90 * DAY_MS);

		expect(await stores.audit.purgeOlderThan(cutoff, 2)).toBe(2);
		expect(await stores.audit.purgeOlderThan(cutoff, 2)).toBe(1);
		expect(await stores.audit.purgeOlderThan(cutoff, 2)).toBe(0);

		expect((await stores.audit.list(acme, {}, page)).items.map((entry) => entry.id)).toEqual([
			recent.id,
		]);
		expect((await stores.audit.list(globex, {}, page)).total).toBe(0);
	});
});

describe("audit_events is append-only in postgres", () => {
	const audit = new PostgresAuditRepository(pool);

	it("rejects any update, even of an old row", async () => {
		const entry = anAudit(acme, "incident.created", {
			occurredAt: new Date(Date.now() - 200 * DAY_MS),
		});
		await audit.record(entry);

		await expect(
			pool.query("UPDATE audit_events SET action = 'incident.resolved' WHERE id = $1", [entry.id]),
		).rejects.toThrow("cannot be changed");
	});

	it("rejects deleting a row younger than 90 days, even through the purge", async () => {
		const entry = anAudit(acme, "incident.created", { occurredAt: new Date() });
		await audit.record(entry);

		await expect(pool.query("DELETE FROM audit_events WHERE id = $1", [entry.id])).rejects.toThrow(
			"younger than 90 days",
		);
		// A purge with a wrong, future cutoff is refused by the trigger too.
		await expect(audit.purgeOlderThan(new Date(Date.now() + DAY_MS), 10)).rejects.toThrow(
			"younger than 90 days",
		);
		expect((await audit.list(acme, {}, { limit: 10, offset: 0 })).total).toBe(1);
	});
});
