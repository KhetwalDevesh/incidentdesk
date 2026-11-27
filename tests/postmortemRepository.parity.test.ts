import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncidentId } from "../src/contract/incidents";
import type { Incident, IncidentRepository } from "../src/domain/incidents/types";
import type {
	PostmortemDraftRepository,
	PostmortemRepository,
} from "../src/domain/postmortems/types";
import type { TenantId } from "../src/domain/shared/identity";
import type { DraftRequest, SummaryDraftRepository } from "../src/domain/summaries/types";
import { InMemoryAuditStore } from "../src/repository/audit/inMemoryAuditStore";
import { InMemoryChangeFeed } from "../src/repository/events/inMemoryChangeFeed";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { PostgresIncidentRepository } from "../src/repository/incidents/postgresIncidentRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { InMemoryPostmortemRepository } from "../src/repository/postmortems/inMemoryPostmortemRepository";
import { PostgresPostmortemDraftRepository } from "../src/repository/postmortems/postgresPostmortemDraftRepository";
import { PostgresPostmortemRepository } from "../src/repository/postmortems/postgresPostmortemRepository";
import { InMemorySummaryDraftRepository } from "../src/repository/summaries/inMemorySummaryDraftRepository";
import { PostgresSummaryDraftRepository } from "../src/repository/summaries/postgresSummaryDraftRepository";
import { anAudit } from "./auditEntries";

// Spec: docs/features/ai-postmortems.md

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema: claim serves every tenant.
const SCHEMA = "postmortem_parity";
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
	incidents: IncidentRepository;
	drafts: PostmortemDraftRepository;
	summaries: SummaryDraftRepository;
	postmortems: PostmortemRepository;
};

const inMemory = (): Stores => {
	const feed = new InMemoryChangeFeed();
	const audit = new InMemoryAuditStore();
	const summaries = new InMemorySummaryDraftRepository(feed);
	const incidents = new InMemoryIncidentRepository(audit, undefined, null, feed, summaries);
	return {
		incidents,
		drafts: incidents.postmortemDrafts,
		summaries,
		postmortems: new InMemoryPostmortemRepository(audit, feed),
	};
};

const postgres = (): Stores => ({
	incidents: new PostgresIncidentRepository(pool),
	drafts: new PostgresPostmortemDraftRepository(pool),
	summaries: new PostgresSummaryDraftRepository(pool),
	postmortems: new PostgresPostmortemRepository(pool),
});

const DAY = new Date("2026-01-10T12:00:00Z");
const at = (ms: number) => new Date(DAY.getTime() + ms);

const CONTENT = {
	summary: "Checkout was slow.",
	impact: "EU customers.",
	timeline: [{ at: "2026-01-10T11:40:00Z", event: "Opened" }],
	suspectedCause: "The data suggests a slow dependency.",
	wentWell: [],
	wentWrong: ["Paging was late"],
	actionItems: ["Add an alert"],
};

const request = (incidentId: IncidentId, overrides: Partial<DraftRequest> = {}): DraftRequest => ({
	id: randomUUID(),
	incidentId,
	requestedBy: null,
	createdAt: DAY,
	dailyCap: 100,
	...overrides,
});

describe.each([
	["in-memory", inMemory],
	["postgres", postgres],
] as const)("postmortem parity: %s", (name, make) => {
	let stores: Stores;
	let acme: TenantId;
	let globex: TenantId;

	beforeEach(async () => {
		if (name === "postgres") {
			await pool.query(
				"TRUNCATE incident_postmortem_drafts, incident_postmortems, incident_summary_drafts, incidents",
			);
		}
		stores = make();
		acme = randomUUID() as TenantId;
		globex = randomUUID() as TenantId;
	});

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

	const open = async (tenantId = acme) => {
		const incident = newIncident();
		await stores.incidents.create(tenantId, incident, [anAudit(tenantId)]);
		return incident.id;
	};

	it("queues a postmortem draft only when the resolving update applies", async () => {
		const incidentId = await open();
		const resolve = () =>
			stores.incidents.update(
				acme,
				incidentId,
				{ status: "open", assigneeId: null },
				{ status: "resolved", resolvedAt: DAY, resolvedBy: "user-1" },
				anAudit(acme, "incident.resolved"),
				undefined,
				request(incidentId),
			);

		expect(await resolve()).not.toBeNull();
		// Already resolved: the update does not apply, so nothing more is queued.
		expect(await resolve()).toBeNull();

		const { items } = await stores.drafts.list(acme, incidentId, { limit: 10, offset: 0 });
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ state: "pending", requestedBy: null, content: null });
	});

	it("returns the pending draft instead of queueing a second", async () => {
		const incidentId = await open();
		const first = await stores.drafts.request(acme, request(incidentId));

		const again = await stores.drafts.request(acme, request(incidentId));

		expect(again.id).toBe(first.id);
	});

	it("shares the daily cap with summary drafts, even under concurrency", async () => {
		const incidents = await Promise.all(Array.from({ length: 6 }, () => open()));
		const cap = { dailyCap: 4 };

		const results = await Promise.all(
			incidents.map((incidentId, n) =>
				n % 2
					? stores.drafts.request(acme, request(incidentId, cap))
					: stores.summaries.request(acme, request(incidentId, cap)),
			),
		);

		expect(results.filter((draft) => draft.state === "pending")).toHaveLength(4);
		expect(results.filter((draft) => draft.state === "skipped")).toHaveLength(2);
		const other = await stores.drafts.request(globex, request(await open(globex), cap));
		expect(other.state).toBe("pending");
	});

	it("claims, retries and finishes a draft once, with its content", async () => {
		const draft = await stores.drafts.request(acme, request(await open()));

		const [claimed] = await stores.drafts.claim(at(0), at(60_000), 10);
		await stores.drafts.retry(acme, draft.id, at(10_000), "HTTP 503");
		const early = await stores.drafts.claim(at(9_999), at(70_000), 10);
		await stores.drafts.claim(at(10_000), at(70_000), 10);
		const ready = await stores.drafts.complete(
			acme,
			draft.id,
			{ state: "ready", content: CONTENT, model: "m", inputTokens: 1, outputTokens: 2 },
			at(11_000),
		);
		const twice = await stores.drafts.complete(
			acme,
			draft.id,
			{ state: "failed", failureReason: "provider_error", error: "late" },
			at(12_000),
		);

		expect(claimed?.attempts).toBe(1);
		expect(early).toEqual([]);
		expect(ready).toMatchObject({
			state: "ready",
			content: CONTENT,
			model: "m",
			attempts: 2,
			lastError: null,
			completedAt: at(11_000),
		});
		expect(twice).toBeNull();
		expect(await stores.drafts.findById(acme, draft.id)).toEqual(ready);
		expect(await stores.drafts.findById(globex, draft.id)).toBeNull();
	});

	it("saves, publishes once, and keeps a published postmortem published when edited", async () => {
		const incidentId = await open();
		const save = (body: string, draftId: string | null, ms: number) =>
			stores.postmortems.save(
				acme,
				incidentId,
				{ body, draftId, updatedBy: "user-1", updatedAt: at(ms) },
				anAudit(acme, "postmortem.saved"),
			);

		const first = await save("## Summary\n\nFirst.", null, 0);
		const published = await stores.postmortems.publish(
			acme,
			incidentId,
			"user-2",
			at(10),
			anAudit(acme, "postmortem.published"),
		);
		const again = await stores.postmortems.publish(
			acme,
			incidentId,
			"user-3",
			at(20),
			anAudit(acme, "postmortem.published"),
		);
		const edited = await save("## Summary\n\nEdited.", null, 30);

		expect(first).toMatchObject({ state: "draft", publishedAt: null, updatedAt: at(0) });
		expect(published).toMatchObject({
			state: "published",
			publishedBy: "user-2",
			publishedAt: at(10),
		});
		expect(again).toEqual(published);
		expect(edited).toMatchObject({
			body: "## Summary\n\nEdited.",
			state: "published",
			publishedBy: "user-2",
			updatedAt: at(30),
		});
		expect(await stores.postmortems.find(acme, incidentId)).toEqual(edited);
	});

	it("hides a postmortem from another tenant, and publishes nothing that does not exist", async () => {
		const incidentId = await open();
		await stores.postmortems.save(
			acme,
			incidentId,
			{ body: "Body", draftId: null, updatedBy: "user-1", updatedAt: at(0) },
			anAudit(acme, "postmortem.saved"),
		);

		expect(await stores.postmortems.find(globex, incidentId)).toBeNull();
		expect(
			await stores.postmortems.publish(
				globex,
				incidentId,
				"u",
				at(1),
				anAudit(globex, "postmortem.published"),
			),
		).toBeNull();
		expect((await stores.postmortems.find(acme, incidentId))?.state).toBe("draft");
	});
});
