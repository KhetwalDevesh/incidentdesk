import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncidentId, IncidentSeverity } from "../src/contract/incidents";
import type { IncidentStatsReader } from "../src/domain/dashboard/types";
import type { Incident, IncidentRepository } from "../src/domain/incidents/types";
import type { TenantId } from "../src/domain/shared/identity";
import { InMemoryIncidentStatsReader } from "../src/repository/dashboard/inMemoryIncidentStatsReader";
import { PostgresIncidentStatsReader } from "../src/repository/dashboard/postgresIncidentStatsReader";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { PostgresIncidentRepository } from "../src/repository/incidents/postgresIncidentRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { anAudit } from "./auditEntries";

// Spec: docs/features/dashboard-stats.md

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema, so other parity tests' TRUNCATEs, which run in parallel, never touch these rows.
const SCHEMA = "dashboard_parity";
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

afterAll(async () => {
	await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
	await Promise.all([admin.end(), pool.end()]);
});

const at = (iso: string) => new Date(iso);

const newIncident = (
	overrides: Partial<Omit<Incident, "tenantId">> = {},
): Omit<Incident, "tenantId"> => ({
	id: randomUUID() as IncidentId,
	title: "Checkout is down",
	severity: "sev2",
	status: "open",
	createdAt: at("2026-01-10T12:00:00Z"),
	createdBy: "user-1",
	acknowledgedAt: null,
	acknowledgedBy: null,
	resolvedAt: null,
	resolvedBy: null,
	alertSourceId: null,
	dedupKey: null,
	alertCount: 0,
	lastAlertAt: null,
	assigneeId: null,
	assignmentCount: 0,
	summary: null,
	...overrides,
});

const zeros = () => ({
	sev1: { open: 0, acknowledged: 0 },
	sev2: { open: 0, acknowledged: 0 },
	sev3: { open: 0, acknowledged: 0 },
	sev4: { open: 0, acknowledged: 0 },
});

// Fixed ids, so the tie-break by id is known: GRACE sorts before ALAN.
const GRACE = "00000000-0000-4000-8000-00000000000a";
const ALAN = "00000000-0000-4000-8000-00000000000b";
const ADA = "00000000-0000-4000-8000-00000000000c";

describe.each([
	[
		"in-memory",
		() => {
			const incidents = new InMemoryIncidentRepository();
			return { incidents, stats: new InMemoryIncidentStatsReader(incidents) };
		},
	],
	[
		"postgres",
		() => ({
			incidents: new PostgresIncidentRepository(pool),
			stats: new PostgresIncidentStatsReader(pool),
		}),
	],
] as const)("dashboard parity: %s", (_name, make) => {
	let incidents: IncidentRepository;
	let stats: IncidentStatsReader;
	let acme: TenantId;
	let globex: TenantId;

	const add = (tenantId: TenantId, overrides: Partial<Omit<Incident, "tenantId">> = {}) =>
		incidents.create(tenantId, newIncident(overrides), [anAudit(tenantId)]);

	const severities = (severity: IncidentSeverity, open: number, acknowledged: number) => ({
		...zeros(),
		[severity]: { open, acknowledged },
	});

	beforeEach(() => {
		({ incidents, stats } = make());
		acme = randomUUID() as TenantId;
		globex = randomUUID() as TenantId;
	});

	it("counts zeros for every severity when there is nothing", async () => {
		expect(await stats.unresolvedStats(acme, null)).toEqual({ bySeverity: zeros(), unassigned: 0 });
		expect(await stats.load(acme, null, 100)).toEqual({ items: [], assigneeCount: 0 });
	});

	it("counts unresolved incidents by severity and status, and the unassigned ones", async () => {
		await add(acme, { severity: "sev1", status: "open" });
		await add(acme, { severity: "sev1", status: "open", assigneeId: GRACE });
		await add(acme, { severity: "sev1", status: "acknowledged", assigneeId: GRACE });
		await add(acme, { severity: "sev3", status: "acknowledged" });
		await add(acme, { severity: "sev3", status: "resolved" });
		await add(globex, { severity: "sev4", status: "open" });

		expect(await stats.unresolvedStats(acme, null)).toEqual({
			bySeverity: {
				...zeros(),
				sev1: { open: 2, acknowledged: 1 },
				sev3: { open: 0, acknowledged: 1 },
			},
			unassigned: 2,
		});
	});

	it("narrows every number to incidents opened at or after from and before to", async () => {
		await add(acme, { createdAt: at("2026-01-10T00:00:00Z"), assigneeId: GRACE });
		await add(acme, { createdAt: at("2026-01-10T23:59:59.999Z") });
		await add(acme, { createdAt: at("2026-01-11T00:00:00Z"), assigneeId: ALAN });
		await add(acme, { createdAt: at("2026-01-09T23:59:59.999Z"), assigneeId: ALAN });
		const window = { from: at("2026-01-10T00:00:00Z"), to: at("2026-01-11T00:00:00Z") };

		expect(await stats.unresolvedStats(acme, window)).toEqual({
			bySeverity: severities("sev2", 2, 0),
			unassigned: 1,
		});
		expect(await stats.load(acme, window, 100)).toEqual({
			items: [{ userId: GRACE, open: 1, acknowledged: 0 }],
			assigneeCount: 1,
		});
	});

	it("lists load per assignee, most first, then by id, cut at the limit with the full count", async () => {
		for (const status of ["open", "acknowledged", "resolved"] as const) {
			await add(acme, { status, assigneeId: ADA });
		}
		await add(acme, { assigneeId: ALAN });
		await add(acme, { assigneeId: GRACE });
		await add(acme, { status: "resolved", assigneeId: randomUUID() });
		await add(globex, { assigneeId: GRACE });

		expect(await stats.load(acme, null, 100)).toEqual({
			items: [
				{ userId: ADA, open: 1, acknowledged: 1 },
				{ userId: GRACE, open: 1, acknowledged: 0 },
				{ userId: ALAN, open: 1, acknowledged: 0 },
			],
			assigneeCount: 3,
		});
		expect(await stats.load(acme, null, 2)).toEqual({
			items: [
				{ userId: ADA, open: 1, acknowledged: 1 },
				{ userId: GRACE, open: 1, acknowledged: 0 },
			],
			assigneeCount: 3,
		});
	});
});
