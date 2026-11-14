import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncidentId } from "../src/contract/incidents";
import type { Incident, IncidentRepository } from "../src/domain/incidents/types";
import type { TenantId } from "../src/domain/shared/identity";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { PostgresIncidentRepository } from "../src/repository/incidents/postgresIncidentRepository";
import { runMigrations } from "../src/repository/postgres/migrate";

// Matches docker-compose.yml. CI sets TEST_DATABASE_URL to its own service.
const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

const acme = "tenant-acme" as TenantId;
const globex = "tenant-globex" as TenantId;

const newIncident = (createdAt: Date, title = "Checkout is down"): Omit<Incident, "tenantId"> => ({
	id: randomUUID() as IncidentId,
	title,
	severity: "sev2",
	status: "open",
	createdAt,
	createdBy: "user-1",
	acknowledgedAt: null,
	acknowledgedBy: null,
	resolvedAt: null,
	resolvedBy: null,
});

const pool = new Pool({ connectionString: TEST_DATABASE_URL });

beforeAll(async () => {
	try {
		await runMigrations(pool);
	} catch (error) {
		throw new Error(
			`Cannot reach the test database at ${new URL(TEST_DATABASE_URL).host}. Run: pnpm db:up`,
			{ cause: error },
		);
	}
});

afterAll(() => pool.end());

describe.each([
	["in-memory", () => new InMemoryIncidentRepository()],
	["postgres", () => new PostgresIncidentRepository(pool)],
] as const)("IncidentRepository parity: %s", (name, make) => {
	let repository: IncidentRepository;

	beforeEach(async () => {
		if (name === "postgres") await pool.query("TRUNCATE incidents");
		repository = make();
	});

	it("round-trips every field", async () => {
		const incident = newIncident(new Date("2026-01-01T00:00:00.123Z"));

		const created = await repository.create(acme, incident);

		expect(created).toEqual({ ...incident, tenantId: acme });
		expect(await repository.findById(acme, incident.id)).toEqual(created);
	});

	it("hides another tenant's incident from findById", async () => {
		const incident = newIncident(new Date());
		await repository.create(acme, incident);

		expect(await repository.findById(globex, incident.id)).toBeNull();
	});

	it("lists only the tenant's incidents, newest first, with a total", async () => {
		const older = newIncident(new Date("2026-01-01T00:00:00Z"), "Older");
		const newer = newIncident(new Date("2026-01-02T00:00:00Z"), "Newer");
		await repository.create(acme, older);
		await repository.create(acme, newer);
		await repository.create(globex, newIncident(new Date()));

		const page = await repository.list(acme, { limit: 1, offset: 0 });

		expect(page.total).toBe(2);
		expect(page.items.map((item) => item.title)).toEqual(["Newer"]);
		expect(
			(await repository.list(acme, { limit: 10, offset: 1 })).items.map((i) => i.title),
		).toEqual(["Older"]);
	});

	it("breaks createdAt ties by id", async () => {
		const at = new Date("2026-01-01T00:00:00Z");
		const incidents = [newIncident(at), newIncident(at), newIncident(at)];
		for (const incident of incidents) await repository.create(acme, incident);

		const page = await repository.list(acme, { limit: 10, offset: 0 });

		expect(page.items.map((item) => item.id)).toEqual(incidents.map((i) => i.id).sort());
	});

	it("returns an empty page past the end, with the real total", async () => {
		await repository.create(acme, newIncident(new Date()));

		expect(await repository.list(acme, { limit: 10, offset: 5 })).toEqual({ items: [], total: 1 });
	});

	it("updates when the status still matches", async () => {
		const incident = newIncident(new Date());
		await repository.create(acme, incident);
		const at = new Date("2026-01-03T00:00:00Z");

		const updated = await repository.update(acme, incident.id, "open", {
			status: "acknowledged",
			acknowledgedAt: at,
			acknowledgedBy: "user-2",
		});

		expect(updated).toMatchObject({
			status: "acknowledged",
			acknowledgedAt: at,
			acknowledgedBy: "user-2",
		});
		expect(await repository.findById(acme, incident.id)).toEqual(updated);
	});

	it("round-trips the resolution fields", async () => {
		const incident = newIncident(new Date());
		await repository.create(acme, incident);
		const at = new Date("2026-01-04T00:00:00Z");

		const updated = await repository.update(acme, incident.id, "open", {
			status: "resolved",
			resolvedAt: at,
			resolvedBy: "user-3",
		});

		expect(updated).toMatchObject({ status: "resolved", resolvedAt: at, resolvedBy: "user-3" });
		expect(await repository.findById(acme, incident.id)).toEqual(updated);
	});

	it("refuses an update when the status has moved on", async () => {
		const incident = newIncident(new Date());
		await repository.create(acme, incident);
		await repository.update(acme, incident.id, "open", { status: "resolved" });

		expect(
			await repository.update(acme, incident.id, "open", { status: "acknowledged" }),
		).toBeNull();
		expect((await repository.findById(acme, incident.id))?.status).toBe("resolved");
	});

	it("refuses to update another tenant's incident", async () => {
		const incident = newIncident(new Date());
		await repository.create(acme, incident);

		expect(await repository.update(globex, incident.id, "open", { status: "resolved" })).toBeNull();
		expect((await repository.findById(acme, incident.id))?.status).toBe("open");
	});

	it("lets exactly one of many concurrent updates win", async () => {
		const incident = newIncident(new Date());
		await repository.create(acme, incident);

		const results = await Promise.all(
			Array.from({ length: 10 }, (_, n) =>
				repository.update(acme, incident.id, "open", {
					status: "acknowledged",
					acknowledgedBy: `user-${n}`,
				}),
			),
		);

		expect(results.filter((result) => result !== null)).toHaveLength(1);
	});
});
