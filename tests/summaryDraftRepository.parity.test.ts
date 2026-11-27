import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncidentId } from "../src/contract/incidents";
import type { Alert, AlertRepository } from "../src/domain/alerts/types";
import type { Incident, IncidentRepository } from "../src/domain/incidents/types";
import type { TenantId } from "../src/domain/shared/identity";
import type { DraftRequest, SummaryDraftRepository } from "../src/domain/summaries/types";
import { InMemoryAlertRepository } from "../src/repository/alerts/inMemoryAlertRepository";
import { PostgresAlertRepository } from "../src/repository/alerts/postgresAlertRepository";
import { InMemoryAuditStore } from "../src/repository/audit/inMemoryAuditStore";
import { InMemoryChangeFeed } from "../src/repository/events/inMemoryChangeFeed";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { PostgresIncidentRepository } from "../src/repository/incidents/postgresIncidentRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { InMemorySummaryDraftRepository } from "../src/repository/summaries/inMemorySummaryDraftRepository";
import { PostgresSummaryDraftRepository } from "../src/repository/summaries/postgresSummaryDraftRepository";
import { anAudit, groupingAudit } from "./auditEntries";

// Spec: docs/features/ai-summaries.md

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema: claim serves every tenant, so rows from other files would be claimed here.
const SCHEMA = "summary_draft_parity";
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

type Stores = {
	drafts: SummaryDraftRepository;
	incidents: IncidentRepository;
	alerts: AlertRepository;
};

const inMemory = (): Stores => {
	const feed = new InMemoryChangeFeed();
	const drafts = new InMemorySummaryDraftRepository(feed);
	const incidents = new InMemoryIncidentRepository(
		new InMemoryAuditStore(),
		undefined,
		null,
		feed,
		drafts,
	);
	return { drafts, incidents, alerts: new InMemoryAlertRepository(incidents) };
};

const postgres = (): Stores => ({
	drafts: new PostgresSummaryDraftRepository(pool),
	incidents: new PostgresIncidentRepository(pool),
	alerts: new PostgresAlertRepository(pool),
});

const DAY = new Date("2026-01-10T12:00:00Z");
const at = (ms: number) => new Date(DAY.getTime() + ms);

const newIncident = (): Omit<Incident, "tenantId"> => ({
	id: randomUUID() as IncidentId,
	title: "Checkout is down",
	severity: "sev1",
	status: "open",
	createdAt: DAY,
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
});

const request = (incidentId: IncidentId, overrides: Partial<DraftRequest> = {}): DraftRequest => ({
	id: randomUUID(),
	incidentId,
	requestedBy: "user-1",
	createdAt: DAY,
	dailyCap: 100,
	...overrides,
});

describe.each([
	["in-memory", inMemory],
	["postgres", postgres],
] as const)("summary draft parity: %s", (name, make) => {
	let stores: Stores;
	let acme: TenantId;
	let globex: TenantId;

	beforeEach(async () => {
		if (name === "postgres")
			await pool.query("TRUNCATE incident_summary_drafts, incidents, alerts");
		stores = make();
		acme = randomUUID() as TenantId;
		globex = randomUUID() as TenantId;
	});

	const open = async (tenantId = acme, draft?: Partial<DraftRequest>) => {
		const incident = newIncident();
		await stores.incidents.create(
			tenantId,
			incident,
			[anAudit(tenantId)],
			undefined,
			draft ? request(incident.id, draft) : undefined,
		);
		return incident.id;
	};

	it("queues a draft with the incident that opens, in the same change", async () => {
		const incidentId = await open(acme, { requestedBy: null });

		const { items, total } = await stores.drafts.list(acme, incidentId, { limit: 10, offset: 0 });

		expect(total).toBe(1);
		expect(items[0]).toMatchObject({
			tenantId: acme,
			incidentId,
			state: "pending",
			requestedBy: null,
			attempts: 0,
			summary: null,
			failureReason: null,
			completedAt: null,
		});
	});

	it("returns the pending draft instead of queueing a second", async () => {
		const incidentId = await open(acme, {});

		const again = await stores.drafts.request(acme, request(incidentId));
		const { items, total } = await stores.drafts.list(acme, incidentId, { limit: 10, offset: 0 });

		expect(total).toBe(1);
		expect(again.id).toBe(items[0]?.id);
	});

	it("skips drafts over the daily cap, not counting skipped ones, and starts again at midnight UTC", async () => {
		const incidents = [await open(), await open(), await open(), await open()];
		const cap = { dailyCap: 2 };

		const first = await stores.drafts.request(acme, request(incidents[0] as IncidentId, cap));
		const second = await stores.drafts.request(acme, request(incidents[1] as IncidentId, cap));
		const third = await stores.drafts.request(acme, request(incidents[2] as IncidentId, cap));
		const other = await stores.drafts.request(globex, request(await open(globex), cap));
		const tomorrow = await stores.drafts.request(
			acme,
			request(incidents[3] as IncidentId, { ...cap, createdAt: new Date("2026-01-11T00:00:00Z") }),
		);

		expect([first.state, second.state, third.state]).toEqual(["pending", "pending", "skipped"]);
		expect(third).toMatchObject({ failureReason: "over_daily_cap", completedAt: DAY });
		expect(other.state).toBe("pending");
		expect(tomorrow.state).toBe("pending");
	});

	it("never lets concurrent requests pass the cap", async () => {
		const incidents = await Promise.all(Array.from({ length: 8 }, () => open()));

		const drafts = await Promise.all(
			incidents.map((incidentId) =>
				stores.drafts.request(acme, request(incidentId, { dailyCap: 3 })),
			),
		);

		expect(drafts.filter((draft) => draft.state === "pending")).toHaveLength(3);
		expect(drafts.filter((draft) => draft.state === "skipped")).toHaveLength(5);
	});

	it("claims due drafts across tenants, holding each until its lease ends", async () => {
		const a = await stores.drafts.request(acme, request(await open()));
		const b = await stores.drafts.request(
			globex,
			request(await open(globex), { createdAt: at(1) }),
		);

		const claimed = await stores.drafts.claim(at(5), at(60_000), 10);
		const again = await stores.drafts.claim(at(10), at(60_010), 10);
		const afterLease = await stores.drafts.claim(at(60_000), at(120_000), 10);

		expect(claimed.map((draft) => [draft.id, draft.attempts])).toEqual([
			[a.id, 1],
			[b.id, 1],
		]);
		expect(again).toEqual([]);
		expect(afterLease.map((draft) => draft.attempts)).toEqual([2, 2]);
	});

	it("schedules a retry, and finishes a draft only once", async () => {
		const draft = await stores.drafts.request(acme, request(await open()));
		await stores.drafts.claim(at(0), at(60_000), 10);
		await stores.drafts.retry(acme, draft.id, at(10_000), "HTTP 503");

		expect(await stores.drafts.claim(at(9_999), at(70_000), 10)).toEqual([]);
		expect((await stores.drafts.claim(at(10_000), at(70_000), 10)).map((d) => d.id)).toEqual([
			draft.id,
		]);

		const ready = await stores.drafts.complete(
			acme,
			draft.id,
			{
				state: "ready",
				summary: "Checkout latency is high.",
				suggestedSeverity: "sev1",
				rationale: "Customer-facing.",
				model: "qwen/qwen3-30b-a3b-instruct-2507",
				inputTokens: 1200,
				outputTokens: 80,
			},
			at(11_000),
		);
		const twice = await stores.drafts.complete(
			acme,
			draft.id,
			{ state: "failed", failureReason: "provider_error", error: "late" },
			at(12_000),
		);

		expect(ready).toMatchObject({
			state: "ready",
			summary: "Checkout latency is high.",
			suggestedSeverity: "sev1",
			model: "qwen/qwen3-30b-a3b-instruct-2507",
			inputTokens: 1200,
			outputTokens: 80,
			completedAt: at(11_000),
			attempts: 2,
			lastError: null,
		});
		expect(twice).toBeNull();
		expect(await stores.drafts.findById(acme, draft.id)).toEqual(ready);
	});

	it("records a failure with its reason", async () => {
		const draft = await stores.drafts.request(acme, request(await open()));

		const failed = await stores.drafts.complete(
			acme,
			draft.id,
			{
				state: "failed",
				failureReason: "invalid_output",
				error: "output did not match the schema",
			},
			at(1),
		);

		expect(failed).toMatchObject({
			state: "failed",
			failureReason: "invalid_output",
			lastError: "output did not match the schema",
			summary: null,
		});
	});

	it("lists an incident's drafts newest first, and hides them from another tenant", async () => {
		const incidentId = await open();
		const older = await stores.drafts.request(acme, request(incidentId));
		await stores.drafts.complete(
			acme,
			older.id,
			{ state: "skipped", failureReason: "ai_disabled", error: null },
			at(1),
		);
		const newer = await stores.drafts.request(acme, request(incidentId, { createdAt: at(5) }));

		const page = await stores.drafts.list(acme, incidentId, { limit: 1, offset: 0 });

		expect(page).toMatchObject({ total: 2, items: [{ id: newer.id }] });
		expect(await stores.drafts.findById(globex, older.id)).toBeNull();
		expect((await stores.drafts.list(globex, incidentId, { limit: 10, offset: 0 })).total).toBe(0);
		expect(
			await stores.drafts.complete(
				globex,
				newer.id,
				{ state: "skipped", failureReason: "ai_disabled", error: null },
				at(6),
			),
		).toBeNull();
	});

	it("sets a summary, and a severity only while unresolved and unchanged", async () => {
		const incidentId = await open();
		const summary = {
			text: "Checkout is slow.",
			updatedAt: at(1),
			updatedBy: "user-1",
			draftId: null,
		};

		const set = await stores.incidents.setSummary(
			acme,
			incidentId,
			{ summary, severity: { from: "sev1", to: "sev2" } },
			[anAudit(acme, "incident.summary_set")],
		);
		const stale = await stores.incidents.setSummary(
			acme,
			incidentId,
			{ summary, severity: { from: "sev1", to: "sev3" } },
			[anAudit(acme, "incident.summary_set")],
		);
		const foreign = await stores.incidents.setSummary(
			globex,
			incidentId,
			{ summary, severity: null },
			[anAudit(globex, "incident.summary_set")],
		);

		expect(set).toMatchObject({ severity: "sev2", summary });
		expect(stale).toBeNull();
		expect(foreign).toBeNull();
		expect(await stores.incidents.findById(acme, incidentId)).toMatchObject({
			severity: "sev2",
			summary,
		});
	});

	describe("alerts", () => {
		// Real tenants and a source, because alerts reference them.
		const sourceFor = async (tenantId: TenantId) => {
			const id = randomUUID();
			if (name === "postgres") {
				await pool.query("INSERT INTO tenants (id, name, created_at) VALUES ($1, 'Acme', now())", [
					tenantId,
				]);
				await pool.query(
					`INSERT INTO alert_sources (tenant_id, id, name, secret_ciphertext, secret_hint, created_at)
					VALUES ($1, $2, 'prometheus', '\\x01', 'WXYZ', now())`,
					[tenantId, id],
				);
			}
			return id;
		};

		const alert = (sourceId: string, ms: number): Omit<Alert, "tenantId"> => ({
			id: randomUUID(),
			sourceId,
			dedupKey: "checkout",
			status: "firing",
			title: `Checkout latency high ${ms}`,
			severity: "sev1",
			details: {},
			state: "pending",
			attempts: 0,
			nextAttemptAt: at(ms),
			lastError: null,
			incidentId: null,
			receivedAt: at(ms),
			processedAt: null,
			sentAt: null,
		});

		it("queues a draft only for the alert that opens an incident, and lists its alerts newest first", async () => {
			const sourceId = await sourceFor(acme);
			const candidate = {
				...newIncident(),
				alertSourceId: sourceId,
				dedupKey: "checkout",
				alertCount: 1,
			};
			const outcomes = [];
			for (const ms of [1000, 2000, 3000]) {
				const each = alert(sourceId, ms);
				await stores.alerts.enqueue(acme, each);
				outcomes.push(
					await stores.alerts.complete(
						acme,
						each.id,
						{ ...candidate, id: randomUUID() as IncidentId },
						at(ms),
						groupingAudit(acme),
						undefined,
						({ incidentId, opened }) =>
							opened && incidentId ? request(incidentId, { requestedBy: null }) : null,
					),
				);
			}
			const incidentId = outcomes[0]?.incidentId as IncidentId;

			const drafts = await stores.drafts.list(acme, incidentId, { limit: 10, offset: 0 });
			const alerts = await stores.alerts.listForIncident(acme, incidentId, 2);

			expect(drafts.total).toBe(1);
			expect(alerts.map((each) => each.title)).toEqual([
				"Checkout latency high 3000",
				"Checkout latency high 2000",
			]);
			expect(await stores.alerts.listForIncident(globex, incidentId, 10)).toEqual([]);
		});
	});
});
