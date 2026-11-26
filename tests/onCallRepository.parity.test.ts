import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncidentId } from "../src/contract/incidents";
import type { AlertSource, AlertSourceRepository } from "../src/domain/alerts/types";
import type { AccountRepository, CredentialStore, User } from "../src/domain/auth/types";
import type { Incident, IncidentRepository } from "../src/domain/incidents/types";
import type {
	DeliveryNotice,
	NotificationChannel,
	NotificationChannelRepository,
	NotificationDeliveryRepository,
} from "../src/domain/notifications/types";
import type { OnCallRepository, ScheduleFields } from "../src/domain/onCall/types";
import type { TenantId } from "../src/domain/shared/identity";
import { InMemoryAccountRepository } from "../src/repository/accounts/inMemoryAccountRepository";
import { PostgresAccountRepository } from "../src/repository/accounts/postgresAccountRepository";
import { InMemoryAlertSourceRepository } from "../src/repository/alerts/inMemoryAlertSourceRepository";
import { PostgresAlertSourceRepository } from "../src/repository/alerts/postgresAlertSourceRepository";
import { InMemoryAuditStore } from "../src/repository/audit/inMemoryAuditStore";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { PostgresIncidentRepository } from "../src/repository/incidents/postgresIncidentRepository";
import { InMemoryNotificationChannelRepository } from "../src/repository/notifications/inMemoryNotificationChannelRepository";
import { InMemoryNotificationDeliveryRepository } from "../src/repository/notifications/inMemoryNotificationDeliveryRepository";
import { PostgresNotificationChannelRepository } from "../src/repository/notifications/postgresNotificationChannelRepository";
import { PostgresNotificationDeliveryRepository } from "../src/repository/notifications/postgresNotificationDeliveryRepository";
import { InMemoryOnCallRepository } from "../src/repository/onCall/inMemoryOnCallRepository";
import { PostgresOnCallRepository } from "../src/repository/onCall/postgresOnCallRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { anAudit } from "./auditEntries";
import { savedSource } from "./outcomes";

// Spec: docs/features/on-call-schedules.md

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema, so other parity tests' TRUNCATEs, which run in parallel, never touch these rows.
const SCHEMA = "on_call_parity";
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
	accounts: AccountRepository & CredentialStore;
	schedules: OnCallRepository;
	sources: AlertSourceRepository;
	incidents: IncidentRepository;
	channels: NotificationChannelRepository;
	deliveries: NotificationDeliveryRepository;
};

const inMemory = (): Stores => {
	const audit = new InMemoryAuditStore();
	const accounts = new InMemoryAccountRepository(audit);
	const schedules = new InMemoryOnCallRepository(accounts);
	const channels = new InMemoryNotificationChannelRepository(audit);
	const deliveries = new InMemoryNotificationDeliveryRepository(channels);
	return {
		accounts,
		schedules,
		sources: new InMemoryAlertSourceRepository(audit, schedules),
		incidents: new InMemoryIncidentRepository(audit, deliveries, accounts),
		channels,
		deliveries,
	};
};

const postgres = (): Stores => ({
	accounts: new PostgresAccountRepository(pool),
	schedules: new PostgresOnCallRepository(pool),
	sources: new PostgresAlertSourceRepository(pool),
	incidents: new PostgresIncidentRepository(pool),
	channels: new PostgresNotificationChannelRepository(pool),
	deliveries: new PostgresNotificationDeliveryRepository(pool),
});

const CREATED = new Date("2026-01-01T00:00:00.123Z");
const LATER = new Date("2030-01-01T00:00:00Z");

const schedule = (
	name: string,
	participantIds: string[] = [],
	overrides: Partial<ScheduleFields> = {},
): ScheduleFields & { createdAt: Date } => ({
	id: randomUUID(),
	name,
	timeZone: "Europe/London",
	handoffTime: "09:00",
	rotationDays: 7,
	startsOn: "2026-01-05",
	isDefault: false,
	participantIds,
	createdAt: CREATED,
	...overrides,
});

const scheduleAudit = (tenantId: TenantId) =>
	anAudit(tenantId, "on_call_schedule.created", {
		resource: { type: "on_call_schedule", id: randomUUID() },
	});

const incident = (assigneeId: string | null = null): Omit<Incident, "tenantId"> => ({
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
	assigneeId,
	assignmentCount: 0,
});

const reassignedNotice = (incidentId: IncidentId, email: string | null): DeliveryNotice => ({
	incidentId,
	event: "incident.reassigned",
	severity: "sev1",
	createdAt: LATER,
	payload: {
		title: "Checkout is down",
		severity: "sev1",
		actor: { type: "user", email: "ada@example.com" },
		alertCount: 0,
		openedAt: CREATED.toISOString(),
		occurredAt: LATER.toISOString(),
		assignee: email === null ? null : { email },
	},
});

const at = (iso: string) => new Date(iso);

describe.each([
	["in-memory", inMemory],
	["postgres", postgres],
] as const)("on-call parity: %s", (_name, make) => {
	let stores: Stores;
	let acme: TenantId;
	let globex: TenantId;
	let acmeAdmin: User;

	// A real tenant with an admin, because schedules reference tenants and users.
	const newTenant = async () => {
		const id = randomUUID() as TenantId;
		const owner = newUser("ada");
		await stores.accounts.createTenantWithAdmin(
			{ id, name: "Acme", createdAt: CREATED },
			owner,
			anAudit(id, "tenant.created"),
		);
		return { id, owner: { ...owner, tenantId: id } };
	};

	// Emails are unique across every tenant, and Postgres keeps them between tests.
	const newUser = (name: string): Omit<User, "tenantId"> => ({
		id: randomUUID(),
		email: `${name}.${randomUUID().slice(0, 8)}@example.com`,
		role: "admin",
		passwordHash: "hash",
		createdAt: CREATED,
	});

	const addMember = async (tenantId: TenantId, name: string): Promise<User> => {
		const user = { ...newUser(name), role: "responder" as const };
		await stores.accounts.addUser(
			tenantId,
			user,
			{ tokenHash: randomUUID(), expiresAt: LATER },
			anAudit(tenantId, "member.invited"),
		);
		return { ...user, tenantId };
	};

	const create = async (tenantId: TenantId, fields: ReturnType<typeof schedule>) => {
		const outcome = await stores.schedules.create(tenantId, fields, scheduleAudit(tenantId));
		if (outcome.status !== "saved") throw new Error(`not saved: ${outcome.status}`);
		return outcome.schedule;
	};

	const override = (scheduleId: string, userId: string, startsAt: string, endsAt: string) => ({
		id: randomUUID(),
		scheduleId,
		userId,
		startsAt: at(startsAt),
		endsAt: at(endsAt),
		createdBy: acmeAdmin.id,
		createdAt: CREATED,
	});

	const overrideAudit = (tenantId: TenantId) =>
		anAudit(tenantId, "on_call_override.created", {
			resource: { type: "on_call_schedule", id: randomUUID() },
		});

	beforeEach(async () => {
		stores = make();
		const a = await newTenant();
		acme = a.id;
		acmeAdmin = a.owner;
		globex = (await newTenant()).id;
	});

	describe("schedules", () => {
		it("round-trips every field, with the rotation in order and each member's email", async () => {
			const grace = await addMember(acme, "grace");
			const alan = await addMember(acme, "alan");
			const fields = schedule("Payments", [alan.id, grace.id], {
				timeZone: "Asia/Tokyo",
				handoffTime: "23:30",
				rotationDays: 3,
				startsOn: "2026-02-28",
				isDefault: true,
			});

			const created = await create(acme, fields);

			const expected = {
				id: fields.id,
				tenantId: acme,
				name: "Payments",
				timeZone: "Asia/Tokyo",
				handoffTime: "23:30",
				rotationDays: 3,
				startsOn: "2026-02-28",
				isDefault: true,
				participants: [
					{ userId: alan.id, email: alan.email },
					{ userId: grace.id, email: grace.email },
				],
				createdAt: CREATED,
			};
			expect(created).toEqual(expected);
			expect(await stores.schedules.findById(acme, fields.id)).toEqual(expected);
			expect(await stores.schedules.findDefault(acme)).toEqual(expected);
		});

		it("hides a schedule from another tenant", async () => {
			const created = await create(acme, schedule("Payments"));

			expect(await stores.schedules.findById(globex, created.id)).toBeNull();
			expect(await stores.schedules.findDefault(globex)).toBeNull();
			expect(await stores.schedules.list(globex, { limit: 10, offset: 0 })).toEqual({
				items: [],
				total: 0,
			});
			expect(
				await stores.schedules.update(globex, created.id, { name: "x" }, () =>
					scheduleAudit(globex),
				),
			).toEqual({ status: "not_found" });
			expect(await stores.schedules.delete(globex, created.id, () => scheduleAudit(globex))).toBe(
				false,
			);
		});

		it("lists by name, then pages, with a total", async () => {
			for (const name of ["Search", "Payments", "Ads"]) await create(acme, schedule(name));
			await create(globex, schedule("Billing"));

			const page = await stores.schedules.list(acme, { limit: 2, offset: 1 });

			expect(page.total).toBe(3);
			expect(page.items.map((item) => item.name)).toEqual(["Payments", "Search"]);
		});

		it("refuses a taken name, and members who are unknown or another tenant's, changing nothing", async () => {
			const grace = await addMember(acme, "grace");
			const stranger = await addMember(globex, "stranger");
			await create(acme, schedule("Payments"));

			const taken = await stores.schedules.create(acme, schedule("Payments"), scheduleAudit(acme));
			const strangers = await stores.schedules.create(
				acme,
				schedule("Search", [grace.id, randomUUID(), stranger.id], { isDefault: true }),
				scheduleAudit(acme),
			);

			expect(taken).toEqual({ status: "name_taken" });
			expect(strangers).toEqual({ status: "members_not_found", indexes: [1, 2] });
			expect((await stores.schedules.list(acme, { limit: 10, offset: 0 })).total).toBe(1);
			expect(await stores.schedules.findDefault(acme)).toBeNull();
			// The same name is free in another tenant.
			expect((await create(globex, schedule("Payments"))).name).toBe("Payments");
		});

		it("keeps one default: a new default makes the old one ordinary", async () => {
			const first = await create(acme, schedule("Payments", [], { isDefault: true }));
			const second = await create(acme, schedule("Search", [], { isDefault: true }));
			const other = await create(globex, schedule("Billing", [], { isDefault: true }));

			expect((await stores.schedules.findById(acme, first.id))?.isDefault).toBe(false);
			expect((await stores.schedules.findDefault(acme))?.id).toBe(second.id);
			expect((await stores.schedules.findDefault(globex))?.id).toBe(other.id);
		});

		it("keeps one default when two are made default at once", async () => {
			const results = await Promise.all(
				["A", "B", "C", "D"].map((name) =>
					stores.schedules.create(
						acme,
						schedule(name, [], { isDefault: true }),
						scheduleAudit(acme),
					),
				),
			);

			expect(results.map((result) => result.status)).toEqual(["saved", "saved", "saved", "saved"]);
			const { items } = await stores.schedules.list(acme, { limit: 10, offset: 0 });
			expect(items.filter((item) => item.isDefault)).toHaveLength(1);
		});

		it("changes only the fields given, and replaces the rotation", async () => {
			const grace = await addMember(acme, "grace");
			const alan = await addMember(acme, "alan");
			const created = await create(acme, schedule("Payments", [grace.id]));
			let before: unknown = null;

			const outcome = await stores.schedules.update(
				acme,
				created.id,
				{ handoffTime: "18:15", participantIds: [alan.id, grace.id], isDefault: true },
				(schedule) => {
					before = schedule;
					return scheduleAudit(acme);
				},
			);

			expect(before).toEqual(created);
			expect(outcome).toEqual({
				status: "saved",
				schedule: {
					...created,
					handoffTime: "18:15",
					isDefault: true,
					participants: [
						{ userId: alan.id, email: alan.email },
						{ userId: grace.id, email: grace.email },
					],
				},
			});
		});

		it("refuses an update to a taken name, or to members it does not have", async () => {
			await create(acme, schedule("Payments"));
			const search = await create(acme, schedule("Search"));
			const audit = () => scheduleAudit(acme);

			expect(await stores.schedules.update(acme, search.id, { name: "Payments" }, audit)).toEqual({
				status: "name_taken",
			});
			expect(
				await stores.schedules.update(acme, search.id, { participantIds: [randomUUID()] }, audit),
			).toEqual({ status: "members_not_found", indexes: [0] });
			// Keeping its own name is not a clash.
			expect(
				(await stores.schedules.update(acme, search.id, { name: "Search" }, audit)).status,
			).toBe("saved");
		});

		it("deletes a schedule with its overrides, and unlinks its alert sources", async () => {
			const grace = await addMember(acme, "grace");
			const created = await create(acme, schedule("Payments", [grace.id], { isDefault: true }));
			await stores.schedules.addOverride(
				acme,
				override(created.id, grace.id, "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z"),
				overrideAudit(acme),
			);
			const source = savedSource(
				await stores.sources.create(acme, newSource(created.id), anAudit(acme)),
			);

			expect(await stores.schedules.delete(acme, created.id, () => scheduleAudit(acme))).toBe(true);

			expect(await stores.schedules.findById(acme, created.id)).toBeNull();
			expect(await stores.schedules.findDefault(acme)).toBeNull();
			expect(
				await stores.schedules.overridesFrom(acme, created.id, at("2000-01-01T00:00:00Z"), 10),
			).toEqual([]);
			const [listed] = (await stores.sources.list(acme, { limit: 10, offset: 0 })).items;
			expect(listed).toEqual({ ...source, onCallScheduleId: null });
		});
	});

	describe("overrides", () => {
		let scheduleId: string;
		let grace: User;
		let alan: User;

		beforeEach(async () => {
			grace = await addMember(acme, "grace");
			alan = await addMember(acme, "alan");
			scheduleId = (await create(acme, schedule("Payments", [grace.id]))).id;
		});

		it("adds an override with the member's email, and reads it back", async () => {
			const input = override(scheduleId, alan.id, "2030-01-01T00:00:00Z", "2030-01-08T00:00:00Z");

			const outcome = await stores.schedules.addOverride(acme, input, overrideAudit(acme));

			const expected = { ...input, tenantId: acme, email: alan.email };
			expect(outcome).toEqual({ status: "added", override: expected });
			expect(await stores.schedules.findOverride(acme, scheduleId, input.id)).toEqual(expected);
			expect(await stores.schedules.findOverride(globex, scheduleId, input.id)).toBeNull();
		});

		it("refuses an overlap, but allows one that starts as another ends", async () => {
			const add = (startsAt: string, endsAt: string) =>
				stores.schedules.addOverride(
					acme,
					override(scheduleId, alan.id, startsAt, endsAt),
					overrideAudit(acme),
				);
			await add("2030-01-02T00:00:00Z", "2030-01-04T00:00:00Z");

			expect((await add("2030-01-03T00:00:00Z", "2030-01-05T00:00:00Z")).status).toBe("overlaps");
			expect((await add("2030-01-01T00:00:00Z", "2030-01-10T00:00:00Z")).status).toBe("overlaps");
			expect((await add("2030-01-04T00:00:00Z", "2030-01-05T00:00:00Z")).status).toBe("added");
			expect((await add("2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z")).status).toBe("added");
		});

		it("lets exactly one of several concurrent overlapping overrides in", async () => {
			const results = await Promise.all(
				Array.from({ length: 5 }, () =>
					stores.schedules.addOverride(
						acme,
						override(scheduleId, alan.id, "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z"),
						overrideAudit(acme),
					),
				),
			);

			expect(results.map((result) => result.status).sort()).toEqual([
				"added",
				"overlaps",
				"overlaps",
				"overlaps",
				"overlaps",
			]);
		});

		it("refuses an unknown or another tenant's schedule or member", async () => {
			const stranger = await addMember(globex, "stranger");
			const add = (tenantId: TenantId, schedule: string, userId: string) =>
				stores.schedules.addOverride(
					tenantId,
					override(schedule, userId, "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z"),
					overrideAudit(tenantId),
				);

			expect(await add(acme, randomUUID(), alan.id)).toEqual({ status: "schedule_not_found" });
			expect(await add(globex, scheduleId, stranger.id)).toEqual({
				status: "schedule_not_found",
			});
			expect(await add(acme, scheduleId, stranger.id)).toEqual({ status: "member_not_found" });
			expect(await add(acme, scheduleId, randomUUID())).toEqual({ status: "member_not_found" });
		});

		it("lists overrides ending after a time, by start, and pages them", async () => {
			const ranges = [
				["2030-01-05T00:00:00Z", "2030-01-06T00:00:00Z"],
				["2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z"],
				["2030-01-03T00:00:00Z", "2030-01-04T00:00:00Z"],
			] as const;
			for (const [startsAt, endsAt] of ranges) {
				await stores.schedules.addOverride(
					acme,
					override(scheduleId, alan.id, startsAt, endsAt),
					overrideAudit(acme),
				);
			}
			const from = at("2030-01-02T00:00:00Z");

			const page = await stores.schedules.listOverrides(acme, scheduleId, from, {
				limit: 1,
				offset: 1,
			});
			const next = await stores.schedules.overridesFrom(acme, scheduleId, from, 1);

			expect(page.total).toBe(2);
			expect(page.items.map((item) => item.startsAt)).toEqual([at("2030-01-05T00:00:00Z")]);
			expect(next.map((item) => item.startsAt)).toEqual([at("2030-01-03T00:00:00Z")]);
			expect(
				(await stores.schedules.listOverrides(globex, scheduleId, from, { limit: 10, offset: 0 }))
					.total,
			).toBe(0);
		});

		it("deletes an override only within its tenant and schedule", async () => {
			const input = override(scheduleId, alan.id, "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z");
			await stores.schedules.addOverride(acme, input, overrideAudit(acme));
			const other = await create(acme, schedule("Search"));

			expect(
				await stores.schedules.deleteOverride(globex, scheduleId, input.id, overrideAudit(globex)),
			).toBe(false);
			expect(
				await stores.schedules.deleteOverride(acme, other.id, input.id, overrideAudit(acme)),
			).toBe(false);
			expect(
				await stores.schedules.deleteOverride(acme, scheduleId, input.id, overrideAudit(acme)),
			).toBe(true);
			expect(await stores.schedules.findOverride(acme, scheduleId, input.id)).toBeNull();
		});
	});

	describe("removing a member", () => {
		it("removes them from rotations, deletes their overrides and unassigns their incidents", async () => {
			const grace = await addMember(acme, "grace");
			const alan = await addMember(acme, "alan");
			const created = await create(acme, schedule("Payments", [grace.id, alan.id]));
			await stores.schedules.addOverride(
				acme,
				override(created.id, grace.id, "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z"),
				overrideAudit(acme),
			);
			const theirs = incident(grace.id);
			const alans = incident(alan.id);
			await stores.incidents.create(acme, theirs, [anAudit(acme)]);
			await stores.incidents.create(acme, alans, [anAudit(acme)]);

			const outcome = await stores.accounts.removeUsers(acme, [grace.id], (removed) =>
				anAudit(acme, "member.removed", { resource: { type: "user", id: removed.id } }),
			);

			expect(outcome.applied).toBe(true);
			expect((await stores.schedules.findById(acme, created.id))?.participants).toEqual([
				{ userId: alan.id, email: alan.email },
			]);
			expect(
				await stores.schedules.overridesFrom(acme, created.id, at("2000-01-01T00:00:00Z"), 10),
			).toEqual([]);
			expect((await stores.incidents.findById(acme, theirs.id))?.assigneeId).toBeNull();
			expect((await stores.incidents.findById(acme, alans.id))?.assigneeId).toBe(alan.id);
		});
	});

	describe("alert source links", () => {
		it("links and unlinks a source, and refuses a schedule the tenant does not have", async () => {
			const own = await create(acme, schedule("Payments"));
			const foreign = await create(globex, schedule("Payments"));
			const source = savedSource(await stores.sources.create(acme, newSource(null), anAudit(acme)));
			const link = (scheduleId: string | null) =>
				stores.sources.link(acme, source.id, scheduleId, anAudit(acme, "alert_source.updated"));

			expect(await link(own.id)).toEqual({
				status: "saved",
				source: { ...source, onCallScheduleId: own.id },
			});
			expect(await link(foreign.id)).toEqual({ status: "schedule_not_found" });
			expect(await link(randomUUID())).toEqual({ status: "schedule_not_found" });
			expect((await link(null)).status).toBe("saved");
			expect(
				await stores.sources.link(globex, source.id, null, anAudit(globex, "alert_source.updated")),
			).toEqual({ status: "not_found" });
			expect(
				await stores.sources.create(acme, newSource(foreign.id, "grafana"), anAudit(acme)),
			).toEqual({ status: "schedule_not_found" });
		});
	});

	describe("reassigning an incident", () => {
		let grace: User;
		let alan: User;
		let channel: NotificationChannel;

		beforeEach(async () => {
			grace = await addMember(acme, "grace");
			alan = await addMember(acme, "alan");
			channel = {
				id: randomUUID(),
				tenantId: acme,
				kind: "slack_webhook",
				name: "#incidents",
				targetCiphertext: Buffer.from([1]),
				targetHint: "WXYZ",
				minSeverity: "sev4",
				enabled: true,
				createdAt: CREATED,
			};
			const { tenantId: _tenant, ...fields } = channel;
			await stores.channels.create(acme, fields, anAudit(acme, "notification_channel.created"));
		});

		const reassign = (
			id: IncidentId,
			from: string | null,
			to: string | null,
			tenantId: TenantId = acme,
		) =>
			stores.incidents.reassign(
				tenantId,
				id,
				{ from, to },
				anAudit(tenantId, "incident.assigned"),
				reassignedNotice(id, to === alan.id ? alan.email : to === grace.id ? grace.email : null),
			);

		it("moves the incident, counts it, and posts each reassignment once", async () => {
			const opened = incident(grace.id);
			await stores.incidents.create(acme, opened, [anAudit(acme)]);

			const first = await reassign(opened.id, grace.id, alan.id);
			const second = await reassign(opened.id, alan.id, null);

			expect(first).toEqual({
				status: "reassigned",
				incident: { ...opened, tenantId: acme, assigneeId: alan.id, assignmentCount: 1 },
			});
			expect(second).toMatchObject({
				status: "reassigned",
				incident: { assigneeId: null, assignmentCount: 2 },
			});
			const { items } = await stores.deliveries.listForChannel(acme, channel.id, {
				limit: 10,
				offset: 0,
			});
			expect(items.map((item) => [item.event, item.occurrence]).sort()).toEqual([
				["incident.reassigned", 1],
				["incident.reassigned", 2],
			]);
		});

		it("refuses a member it does not have, without changing anything", async () => {
			const stranger = await addMember(globex, "stranger");
			const opened = incident(grace.id);
			await stores.incidents.create(acme, opened, [anAudit(acme)]);

			expect(await reassign(opened.id, grace.id, stranger.id)).toEqual({
				status: "member_not_found",
			});
			expect(await reassign(opened.id, grace.id, randomUUID())).toEqual({
				status: "member_not_found",
			});
			expect((await stores.incidents.findById(acme, opened.id))?.assigneeId).toBe(grace.id);
		});

		it("refuses when the assignee moved on, the incident is resolved, or another tenant's", async () => {
			const opened = incident(grace.id);
			const resolved = { ...incident(grace.id), status: "resolved" as const };
			await stores.incidents.create(acme, opened, [anAudit(acme)]);
			await stores.incidents.create(acme, resolved, [anAudit(acme)]);

			expect(await reassign(opened.id, null, alan.id)).toEqual({ status: "changed" });
			expect(await reassign(resolved.id, grace.id, alan.id)).toEqual({ status: "changed" });
			expect(await reassign(opened.id, grace.id, null, globex)).toEqual({ status: "changed" });
			expect(
				(await stores.deliveries.listForChannel(acme, channel.id, { limit: 10, offset: 0 })).total,
			).toBe(0);
		});

		it("lets only one of two concurrent reassignments from the same assignee win", async () => {
			const opened = incident(grace.id);
			await stores.incidents.create(acme, opened, [anAudit(acme)]);

			const results = await Promise.all([
				reassign(opened.id, grace.id, alan.id),
				reassign(opened.id, grace.id, null),
			]);

			expect(results.map((result) => result.status).sort()).toEqual(["changed", "reassigned"]);
		});

		it("makes an update expecting the old assignee lose", async () => {
			const opened = incident(grace.id);
			await stores.incidents.create(acme, opened, [anAudit(acme)]);
			await reassign(opened.id, grace.id, alan.id);

			const updated = await stores.incidents.update(
				acme,
				opened.id,
				{ status: "open", assigneeId: grace.id },
				{ status: "acknowledged" },
				anAudit(acme, "incident.acknowledged"),
			);

			expect(updated).toBeNull();
			expect((await stores.incidents.findById(acme, opened.id))?.status).toBe("open");
		});
	});
});

const newSource = (
	onCallScheduleId: string | null,
	name = "prometheus",
): Omit<AlertSource, "tenantId"> => ({
	id: randomUUID(),
	name,
	secretCiphertext: Buffer.from([1, 2, 3, 4]),
	secretHint: "WXYZ",
	onCallScheduleId,
	createdAt: CREATED,
});
