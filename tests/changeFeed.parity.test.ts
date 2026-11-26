import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgChangeFeed, type PgChangeFeed } from "../src/adapters/pgChangeFeed";
import type { IncidentId } from "../src/contract/incidents";
import type { Alert, AlertRepository, AlertSourceRepository } from "../src/domain/alerts/types";
import type { AccountRepository, CredentialStore, User } from "../src/domain/auth/types";
import type { ChangeFeed, ChangeNotice, FeedItem } from "../src/domain/events/types";
import type { Incident, IncidentRepository } from "../src/domain/incidents/types";
import type { OnCallRepository } from "../src/domain/onCall/types";
import type { TenantId } from "../src/domain/shared/identity";
import { InMemoryAccountRepository } from "../src/repository/accounts/inMemoryAccountRepository";
import { PostgresAccountRepository } from "../src/repository/accounts/postgresAccountRepository";
import { InMemoryAlertRepository } from "../src/repository/alerts/inMemoryAlertRepository";
import { InMemoryAlertSourceRepository } from "../src/repository/alerts/inMemoryAlertSourceRepository";
import { PostgresAlertRepository } from "../src/repository/alerts/postgresAlertRepository";
import { PostgresAlertSourceRepository } from "../src/repository/alerts/postgresAlertSourceRepository";
import { InMemoryAuditStore } from "../src/repository/audit/inMemoryAuditStore";
import { InMemoryChangeFeed } from "../src/repository/events/inMemoryChangeFeed";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { PostgresIncidentRepository } from "../src/repository/incidents/postgresIncidentRepository";
import { InMemoryNotificationDeliveryRepository } from "../src/repository/notifications/inMemoryNotificationDeliveryRepository";
import { InMemoryOnCallRepository } from "../src/repository/onCall/inMemoryOnCallRepository";
import { PostgresOnCallRepository } from "../src/repository/onCall/postgresOnCallRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { anAudit, groupingAudit } from "./auditEntries";
import { savedSource } from "./outcomes";

// Spec: docs/features/realtime-status.md, "Publishing in the transaction".

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema for the tables. NOTIFY is database-wide, so each test reads only notices for
// the tenants it created, which other test files never use.
const SCHEMA = "change_feed_parity";
const admin = new Pool({ connectionString: TEST_DATABASE_URL });
const pool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${SCHEMA}` });
let pgFeed: PgChangeFeed;

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
	pgFeed = createPgChangeFeed({ connectionString: TEST_DATABASE_URL });
	// Listening once the first resync arrives.
	await new Promise<void>((resolve) => {
		const stop = pgFeed.subscribe((item) => {
			if (item.kind === "resync") {
				stop();
				resolve();
			}
		});
	});
});

afterAll(async () => {
	await pgFeed.close();
	await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
	await Promise.all([admin.end(), pool.end()]);
});

type Stores = {
	feed: ChangeFeed;
	accounts: AccountRepository & CredentialStore;
	incidents: IncidentRepository;
	schedules: OnCallRepository;
	sources: AlertSourceRepository;
	alerts: AlertRepository;
};

const inMemory = (): Stores => {
	const audit = new InMemoryAuditStore();
	const feed = new InMemoryChangeFeed();
	const accounts = new InMemoryAccountRepository(audit, feed);
	const incidents = new InMemoryIncidentRepository(
		audit,
		new InMemoryNotificationDeliveryRepository(),
		accounts,
		feed,
	);
	const schedules = new InMemoryOnCallRepository(accounts);
	return {
		feed,
		accounts,
		incidents,
		schedules,
		sources: new InMemoryAlertSourceRepository(audit, schedules),
		alerts: new InMemoryAlertRepository(incidents),
	};
};

const postgres = (): Stores => ({
	feed: pgFeed,
	accounts: new PostgresAccountRepository(pool),
	incidents: new PostgresIncidentRepository(pool),
	schedules: new PostgresOnCallRepository(pool),
	sources: new PostgresAlertSourceRepository(pool),
	alerts: new PostgresAlertRepository(pool),
});

const CREATED = new Date("2026-01-01T00:00:00Z");

const newIncident = (): Omit<Incident, "tenantId"> => ({
	id: randomUUID() as IncidentId,
	title: "Checkout is down",
	severity: "sev1",
	status: "open",
	createdAt: CREATED,
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
});

describe.each([
	["in-memory", inMemory],
	["postgres", postgres],
] as const)("change feed parity: %s", (_name, make) => {
	let stores: Stores;
	let tenant: TenantId;
	let owner: User;
	let seen: ChangeNotice[];
	let stop: () => void;

	beforeEach(async () => {
		stores = make();
		tenant = randomUUID() as TenantId;
		const ownerFields = {
			id: randomUUID(),
			email: `ada.${randomUUID().slice(0, 8)}@example.com`,
			role: "admin" as const,
			passwordHash: "hash",
			createdAt: CREATED,
		};
		await stores.accounts.createTenantWithAdmin(
			{ id: tenant, name: "Acme", createdAt: CREATED },
			ownerFields,
			anAudit(tenant, "tenant.created"),
		);
		owner = { ...ownerFields, tenantId: tenant };
		seen = [];
		stop = stores.feed.subscribe((item: FeedItem) => {
			if (item.kind !== "resync" && item.tenantId === tenant) seen.push(item);
		});
		return () => stop();
	});

	// Notices arrive in commit order, so once a final marker change is seen, every notice before
	// it has arrived, and a change that sent none is proven silent.
	const noticesUpTo = async () => {
		const marker = newIncident();
		await stores.incidents.create(tenant, marker, [anAudit(tenant)]);
		await vi.waitFor(
			() => expect(seen.some((notice) => "id" in notice && notice.id === marker.id)).toBe(true),
			{
				timeout: 2000,
			},
		);
		return seen.slice(0, -1);
	};

	it("notifies each incident change, and nothing for an update that changes no status", async () => {
		const incident = newIncident();
		await stores.incidents.create(tenant, incident, [anAudit(tenant)]);
		await stores.incidents.update(
			tenant,
			incident.id,
			{ status: "open", assigneeId: null },
			{},
			anAudit(tenant),
		);
		await stores.incidents.update(
			tenant,
			incident.id,
			{ status: "open", assigneeId: null },
			{ status: "acknowledged" },
			anAudit(tenant, "incident.acknowledged"),
		);
		await stores.incidents.reassign(
			tenant,
			incident.id,
			{ from: null, to: owner.id },
			anAudit(tenant, "incident.assigned"),
			{
				incidentId: incident.id,
				event: "incident.reassigned",
				severity: "sev1",
				createdAt: CREATED,
				payload: {
					title: "Checkout is down",
					severity: "sev1",
					actor: { type: "user", email: null },
					alertCount: 0,
					openedAt: CREATED.toISOString(),
					occurredAt: CREATED.toISOString(),
				},
			},
		);
		await stores.incidents.update(
			tenant,
			incident.id,
			{ status: "acknowledged", assigneeId: owner.id },
			{ status: "resolved" },
			anAudit(tenant, "incident.resolved"),
		);

		const id = incident.id;
		expect(await noticesUpTo()).toEqual([
			{ kind: "incident", tenantId: tenant, id, event: "incident.opened" },
			{ kind: "incident", tenantId: tenant, id, event: "incident.acknowledged" },
			{ kind: "incident", tenantId: tenant, id, event: "incident.reassigned" },
			{ kind: "incident", tenantId: tenant, id, event: "incident.resolved" },
		]);
	});

	it("notifies nothing for a refused or rolled-back change", async () => {
		const incident = newIncident();
		await stores.incidents.create(tenant, incident, [anAudit(tenant)]);
		// An update expecting the wrong status applies nothing.
		await stores.incidents.update(
			tenant,
			incident.id,
			{ status: "resolved", assigneeId: null },
			{ status: "acknowledged" },
			anAudit(tenant, "incident.acknowledged"),
		);
		// A duplicate audit id makes the transaction fail and roll back.
		const audit = anAudit(tenant);
		await stores.incidents.create(tenant, newIncident(), [audit]);
		await expect(stores.incidents.create(tenant, newIncident(), [audit])).rejects.toThrow();
		// A name already taken refuses the schedule.
		const fields = {
			id: randomUUID(),
			name: "Payments",
			timeZone: "UTC",
			handoffTime: "09:00",
			rotationDays: 7,
			startsOn: "2026-01-05",
			isDefault: false,
			participantIds: [],
			createdAt: CREATED,
		};
		await stores.schedules.create(tenant, fields, anAudit(tenant, "on_call_schedule.created"));
		await stores.schedules.create(
			tenant,
			{ ...fields, id: randomUUID() },
			anAudit(tenant, "on_call_schedule.created"),
		);
		// The last admin cannot be removed.
		await stores.accounts.removeUsers(tenant, [owner.id], () => anAudit(tenant, "member.removed"));

		// The first incident, the second (whose transaction committed), and the first schedule.
		const notices = await noticesUpTo();
		expect(notices.map((notice) => ("event" in notice ? notice.event : notice.kind))).toEqual([
			"incident.opened",
			"incident.opened",
			"on_call_schedule.created",
		]);
	});

	it("notifies an incident an alert opens, and nothing for an alert that joins it", async () => {
		const source = savedSource(
			await stores.sources.create(
				tenant,
				{
					id: randomUUID(),
					name: "prometheus",
					secretCiphertext: Buffer.from([1]),
					secretHint: "WXYZ",
					onCallScheduleId: null,
					createdAt: CREATED,
				},
				anAudit(tenant),
			),
		);
		const alert = (): Omit<Alert, "tenantId"> => ({
			id: randomUUID(),
			sourceId: source.id,
			dedupKey: "checkout",
			status: "firing",
			title: "Checkout is down",
			severity: "sev1",
			details: {},
			state: "pending",
			attempts: 0,
			nextAttemptAt: CREATED,
			lastError: null,
			incidentId: null,
			receivedAt: CREATED,
			processedAt: null,
			sentAt: null,
		});
		const candidate = {
			...newIncident(),
			alertSourceId: source.id,
			dedupKey: "checkout",
			alertCount: 1,
		};
		for (const each of [alert(), alert()]) {
			await stores.alerts.enqueue(tenant, each);
			await stores.alerts.complete(
				tenant,
				each.id,
				{ ...candidate, id: randomUUID() as IncidentId },
				CREATED,
				groupingAudit(tenant),
			);
		}

		expect(await noticesUpTo()).toEqual([
			{ kind: "incident", tenantId: tenant, id: expect.any(String), event: "incident.opened" },
		]);
	});

	it("notifies schedule and override changes, and member removals", async () => {
		const grace = {
			id: randomUUID(),
			email: `grace.${randomUUID().slice(0, 8)}@example.com`,
			role: "responder" as const,
			passwordHash: null,
			createdAt: CREATED,
		};
		await stores.accounts.addUser(
			tenant,
			grace,
			{ tokenHash: randomUUID(), expiresAt: CREATED },
			anAudit(tenant, "member.invited"),
		);
		const scheduleId = randomUUID();
		const overrideId = randomUUID();
		await stores.schedules.create(
			tenant,
			{
				id: scheduleId,
				name: "Payments",
				timeZone: "UTC",
				handoffTime: "09:00",
				rotationDays: 7,
				startsOn: "2026-01-05",
				isDefault: false,
				participantIds: [grace.id],
				createdAt: CREATED,
			},
			anAudit(tenant, "on_call_schedule.created"),
		);
		await stores.schedules.update(tenant, scheduleId, { rotationDays: 14 }, () =>
			anAudit(tenant, "on_call_schedule.updated"),
		);
		await stores.schedules.addOverride(
			tenant,
			{
				id: overrideId,
				scheduleId,
				userId: grace.id,
				startsAt: new Date("2030-01-01T00:00:00Z"),
				endsAt: new Date("2030-01-02T00:00:00Z"),
				createdBy: owner.id,
				createdAt: CREATED,
			},
			anAudit(tenant, "on_call_override.created"),
		);
		await stores.schedules.deleteOverride(
			tenant,
			scheduleId,
			overrideId,
			anAudit(tenant, "on_call_override.deleted"),
		);
		await stores.schedules.delete(tenant, scheduleId, () =>
			anAudit(tenant, "on_call_schedule.deleted"),
		);
		await stores.accounts.removeUsers(tenant, [grace.id], () => anAudit(tenant, "member.removed"));

		const schedule = { kind: "on_call_schedule", tenantId: tenant, id: scheduleId };
		const override = { kind: "on_call_override", tenantId: tenant, scheduleId, id: overrideId };
		expect(await noticesUpTo()).toEqual([
			{ ...schedule, event: "on_call_schedule.created" },
			{ ...schedule, event: "on_call_schedule.updated" },
			{ ...override, event: "on_call_override.created" },
			{ ...override, event: "on_call_override.deleted" },
			{ ...schedule, event: "on_call_schedule.deleted" },
			{ kind: "members_removed", tenantId: tenant, userIds: [grace.id] },
		]);
	});
});

describe("postgres change feed", () => {
	it("reconnects after its connection is killed, and says notices may have been missed", async () => {
		const items: FeedItem[] = [];
		const stop = pgFeed.subscribe((item) => items.push(item));

		const killed = await admin.query(
			`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
			WHERE datname = current_database() AND query = 'LISTEN incidentdesk_changes'`,
		);
		expect(killed.rowCount).toBeGreaterThan(0);

		await vi.waitFor(() => expect(items).toContainEqual({ kind: "resync" }), { timeout: 5000 });
		// Listening again: a committed change arrives.
		const tenant = randomUUID() as TenantId;
		const incident = newIncident();
		await new PostgresIncidentRepository(pool).create(tenant, incident, [anAudit(tenant)]);
		await vi.waitFor(
			() =>
				expect(items).toContainEqual({
					kind: "incident",
					tenantId: tenant,
					id: incident.id,
					event: "incident.opened",
				}),
			{ timeout: 2000 },
		);
		stop();
	});
});
