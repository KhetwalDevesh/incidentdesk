import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncidentId, IncidentSeverity } from "../src/contract/incidents";
import type { AlertRepository, AlertSourceRepository } from "../src/domain/alerts/types";
import type { Incident, IncidentRepository } from "../src/domain/incidents/types";
import type {
	DeliveryNotice,
	DeliveryOutbox,
	DeliveryPurger,
	NotificationChannel,
	NotificationChannelRepository,
	NotificationDeliveryRepository,
	NotificationEvent,
} from "../src/domain/notifications/types";
import type { TenantId } from "../src/domain/shared/identity";
import { InMemoryAlertRepository } from "../src/repository/alerts/inMemoryAlertRepository";
import { InMemoryAlertSourceRepository } from "../src/repository/alerts/inMemoryAlertSourceRepository";
import { PostgresAlertRepository } from "../src/repository/alerts/postgresAlertRepository";
import { PostgresAlertSourceRepository } from "../src/repository/alerts/postgresAlertSourceRepository";
import { InMemoryAuditStore } from "../src/repository/audit/inMemoryAuditStore";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { PostgresIncidentRepository } from "../src/repository/incidents/postgresIncidentRepository";
import { InMemoryNotificationChannelRepository } from "../src/repository/notifications/inMemoryNotificationChannelRepository";
import { InMemoryNotificationDeliveryRepository } from "../src/repository/notifications/inMemoryNotificationDeliveryRepository";
import { PostgresNotificationChannelRepository } from "../src/repository/notifications/postgresNotificationChannelRepository";
import { PostgresNotificationDeliveryRepository } from "../src/repository/notifications/postgresNotificationDeliveryRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { anAudit, groupingAudit } from "./auditEntries";
import { savedSource } from "./outcomes";

// Spec: docs/features/slack-delivery.md
const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema, so other parity tests' TRUNCATEs, which run in parallel, never touch these rows.
const SCHEMA = "delivery_parity";
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

// claimOverdue and the purge serve every tenant, so rows from an earlier test would leak into
// a later one. This schema belongs to this file alone, so emptying it is safe.
beforeEach(async () => {
	await pool.query("TRUNCATE notification_deliveries, alerts, incidents");
});

afterAll(async () => {
	await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
	await Promise.all([admin.end(), pool.end()]);
});

// Real tenants, because notification_channels references tenants.
const newTenant = async (): Promise<TenantId> => {
	const id = randomUUID() as TenantId;
	await pool.query("INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, now())", [
		id,
		"Acme",
	]);
	return id;
};

type Stores = {
	channels: NotificationChannelRepository;
	deliveries: NotificationDeliveryRepository & DeliveryOutbox & DeliveryPurger;
	incidents: IncidentRepository;
	sources: AlertSourceRepository;
	alerts: AlertRepository;
};

const T0 = Date.parse("2030-01-01T00:00:00Z");
const at = (offsetMs = 0) => new Date(T0 + offsetMs);
const PAGE = { limit: 20, offset: 0 };

const newIncident = (severity: IncidentSeverity = "sev2"): Omit<Incident, "tenantId"> => ({
	id: randomUUID() as IncidentId,
	title: "Checkout is down",
	severity,
	status: "open",
	createdAt: at(),
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

const noticeFor = (
	incident: Omit<Incident, "tenantId">,
	event: NotificationEvent = "incident.opened",
	createdAt = at(),
	email: string | null = "grace@acme.example",
): DeliveryNotice => ({
	incidentId: incident.id,
	event,
	severity: incident.severity,
	createdAt,
	payload: {
		title: incident.title,
		severity: incident.severity,
		actor: { type: "user", email },
		alertCount: incident.alertCount,
		openedAt: incident.createdAt.toISOString(),
		occurredAt: createdAt.toISOString(),
	},
});

describe.each([
	[
		"in-memory",
		(): Stores => {
			const audit = new InMemoryAuditStore();
			const channels = new InMemoryNotificationChannelRepository(audit);
			const deliveries = new InMemoryNotificationDeliveryRepository(channels);
			const incidents = new InMemoryIncidentRepository(audit, deliveries);
			return {
				channels,
				deliveries,
				incidents,
				sources: new InMemoryAlertSourceRepository(audit),
				alerts: new InMemoryAlertRepository(incidents),
			};
		},
	],
	[
		"postgres",
		(): Stores => ({
			channels: new PostgresNotificationChannelRepository(pool),
			deliveries: new PostgresNotificationDeliveryRepository(pool),
			incidents: new PostgresIncidentRepository(pool),
			sources: new PostgresAlertSourceRepository(pool),
			alerts: new PostgresAlertRepository(pool),
		}),
	],
] as const)("notification delivery parity: %s", (_name, make) => {
	let stores: Stores;
	let acme: TenantId;
	let globex: TenantId;

	beforeEach(async () => {
		stores = make();
		acme = await newTenant();
		globex = await newTenant();
	});

	let channelClock = 0;
	const addChannel = async (
		tenantId: TenantId,
		name: string,
		{ minSeverity = "sev4", enabled = true }: Partial<NotificationChannel> = {},
	) => {
		channelClock += 1;
		const channel = await stores.channels.create(
			tenantId,
			{
				id: randomUUID(),
				kind: "slack_webhook",
				name,
				targetCiphertext: Buffer.from([1, 2, 3, 4]),
				targetHint: "WXYZ",
				minSeverity,
				enabled,
				createdAt: new Date(T0 - 1_000_000 + channelClock),
			},
			anAudit(tenantId),
		);
		if (!channel) throw new Error("channel not created");
		return channel;
	};

	const deliveriesOf = async (tenantId: TenantId, channel: NotificationChannel) =>
		(await stores.deliveries.listForChannel(tenantId, channel.id, PAGE)).items;

	// Opens an incident with one delivery to `channel`, and returns that delivery.
	const oneDelivery = async (
		channel: NotificationChannel,
		email: string | null = "grace@acme.example",
	) => {
		const incident = newIncident();
		await stores.incidents.create(
			acme,
			incident,
			[anAudit(acme)],
			noticeFor(incident, "incident.opened", at(), email),
		);
		const [delivery] = await deliveriesOf(acme, channel);
		if (!delivery) throw new Error("no delivery written");
		return delivery;
	};

	describe("writing deliveries with the incident change", () => {
		it("writes one pending delivery per enabled channel whose minimum severity is met", async () => {
			const everything = await addChannel(acme, "#incidents", { minSeverity: "sev4" });
			const exact = await addChannel(acme, "#sev2", { minSeverity: "sev2" });
			const tooSevere = await addChannel(acme, "#sev1", { minSeverity: "sev1" });
			const disabled = await addChannel(acme, "#paused", { enabled: false });
			const otherTenant = await addChannel(globex, "#incidents");
			const incident = newIncident("sev2");
			const notice = noticeFor(incident);

			await stores.incidents.create(acme, incident, [anAudit(acme)], notice);

			const [delivery] = await deliveriesOf(acme, everything);
			expect(delivery).toEqual({
				id: expect.any(String),
				tenantId: acme,
				channelId: everything.id,
				occurrence: 0,
				incidentId: incident.id,
				event: "incident.opened",
				payload: notice.payload,
				state: "pending",
				attempts: 0,
				nextAttemptAt: notice.createdAt,
				sentAt: null,
				failureReason: null,
				lastStatus: null,
				lastError: null,
				createdAt: notice.createdAt,
				deliveredAt: null,
			});
			expect(await deliveriesOf(acme, exact)).toHaveLength(1);
			expect(await deliveriesOf(acme, tooSevere)).toEqual([]);
			expect(await deliveriesOf(acme, disabled)).toEqual([]);
			expect(await deliveriesOf(globex, otherTenant)).toEqual([]);
		});

		it("writes an update's deliveries only when the update applies", async () => {
			const channel = await addChannel(acme, "#incidents");
			const incident = newIncident();
			await stores.incidents.create(acme, incident, [anAudit(acme)]);

			const lost = await stores.incidents.update(
				acme,
				incident.id,
				{ status: "acknowledged", assigneeId: null },
				{ status: "resolved" },
				anAudit(acme),
				noticeFor(incident, "incident.resolved"),
			);
			const won = await stores.incidents.update(
				acme,
				incident.id,
				{ status: "open", assigneeId: null },
				{ status: "acknowledged" },
				anAudit(acme),
				noticeFor(incident, "incident.acknowledged"),
			);

			expect(lost).toBeNull();
			expect(won).not.toBeNull();
			expect((await deliveriesOf(acme, channel)).map((d) => d.event)).toEqual([
				"incident.acknowledged",
			]);
		});

		it("ignores a repeated notice for the same incident event", async () => {
			const channel = await addChannel(acme, "#incidents");
			const incident = newIncident();
			await stores.incidents.create(acme, incident, [anAudit(acme)]);

			for (let n = 0; n < 2; n++) {
				await stores.incidents.update(
					acme,
					incident.id,
					{ status: "open", assigneeId: null },
					{},
					anAudit(acme),
					noticeFor(incident, "incident.acknowledged"),
				);
			}

			expect(await deliveriesOf(acme, channel)).toHaveLength(1);
		});

		it("writes nothing without a notice, or for a tenant with no channels", async () => {
			const channel = await addChannel(acme, "#incidents");
			const quiet = newIncident();
			await stores.incidents.create(acme, quiet, [anAudit(acme)]);
			const elsewhere = newIncident();
			await stores.incidents.create(globex, elsewhere, [anAudit(globex)], noticeFor(elsewhere));

			expect(await deliveriesOf(acme, channel)).toEqual([]);
			expect(await stores.deliveries.listUnsent(globex, elsewhere.id, "incident.opened")).toEqual(
				[],
			);
		});

		it("writes deliveries for an alert that opens an incident, and none for one that joins it", async () => {
			const channel = await addChannel(acme, "#incidents");
			const source = savedSource(
				await stores.sources.create(
					acme,
					{
						id: randomUUID(),
						name: "prometheus",
						secretCiphertext: Buffer.from([1]),
						secretHint: "WXYZ",
						onCallScheduleId: null,
						createdAt: at(),
					},
					anAudit(acme),
				),
			);
			const enqueue = () =>
				stores.alerts.enqueue(acme, {
					id: randomUUID(),
					sourceId: source.id,
					dedupKey: "checkout",
					status: "firing",
					title: "Checkout is down",
					severity: "sev1",
					details: {},
					state: "pending",
					attempts: 0,
					nextAttemptAt: at(),
					lastError: null,
					incidentId: null,
					receivedAt: at(),
					processedAt: null,
					sentAt: null,
				});
			const candidate = { ...newIncident("sev1"), alertSourceId: source.id, dedupKey: "checkout" };
			const notice = (opened: boolean) => (opened ? noticeFor(candidate) : null);

			const first = await enqueue();
			await stores.alerts.complete(
				acme,
				first.id,
				candidate,
				at(),
				groupingAudit(acme),
				({ opened }) => notice(opened),
			);
			const second = await enqueue();
			const rejoin = { ...candidate, id: randomUUID() as IncidentId };
			await stores.alerts.complete(
				acme,
				second.id,
				rejoin,
				at(),
				groupingAudit(acme),
				({ opened }) => (opened ? noticeFor(rejoin) : null),
			);

			expect((await deliveriesOf(acme, channel)).map((d) => d.incidentId)).toEqual([candidate.id]);
		});
	});

	describe("sending", () => {
		it("lists unsent deliveries for an incident event until each is marked sent", async () => {
			const channel = await addChannel(acme, "#incidents");
			await addChannel(acme, "#oncall");
			const incident = newIncident();
			await stores.incidents.create(acme, incident, [anAudit(acme)], noticeFor(incident));

			const unsent = await stores.deliveries.listUnsent(acme, incident.id, "incident.opened");
			expect(unsent).toHaveLength(2);
			expect(await stores.deliveries.listUnsent(globex, incident.id, "incident.opened")).toEqual(
				[],
			);

			const [first] = await deliveriesOf(acme, channel);
			await stores.deliveries.markSent(acme, first?.id ?? "", at(10));

			expect(await stores.deliveries.listUnsent(acme, incident.id, "incident.opened")).toHaveLength(
				1,
			);
			expect((await deliveriesOf(acme, channel))[0]?.sentAt).toEqual(at(10));
		});

		it("starts one attempt at a time, holding the delivery until the lease ends", async () => {
			const delivery = await oneDelivery(await addChannel(acme, "#incidents"));

			const started = await stores.deliveries.startAttempt(acme, delivery.id, at(1), at(60_000));
			const duplicate = await stores.deliveries.startAttempt(acme, delivery.id, at(2), at(60_000));
			const afterLease = await stores.deliveries.startAttempt(
				acme,
				delivery.id,
				at(60_000),
				at(120_000),
			);

			expect(started).toMatchObject({ status: "started", delivery: { attempts: 1 } });
			expect(duplicate).toEqual({ status: "leased", until: at(60_000) });
			expect(afterLease).toMatchObject({ status: "started", delivery: { attempts: 2 } });
			expect(await stores.deliveries.startAttempt(globex, delivery.id, at(), at(1))).toBeNull();
			expect(await stores.deliveries.startAttempt(acme, randomUUID(), at(), at(1))).toBeNull();
		});

		it("marks a delivery delivered and removes the actor's email", async () => {
			const channel = await addChannel(acme, "#incidents");
			const delivery = await oneDelivery(channel);
			await stores.deliveries.startAttempt(acme, delivery.id, at(1), at(60_000));

			await stores.deliveries.deliver(acme, delivery.id, 200, at(1200));

			const [stored] = await deliveriesOf(acme, channel);
			expect(stored).toMatchObject({
				state: "delivered",
				deliveredAt: at(1200),
				lastStatus: 200,
				payload: { ...delivery.payload, actor: { type: "user", email: null } },
			});
			expect(JSON.stringify(stored)).not.toContain("grace@acme.example");
			expect(await stores.deliveries.startAttempt(acme, delivery.id, at(70_000), at(1))).toBeNull();
		});

		// Spec: docs/features/on-call-schedules.md, "Slack message".
		it("removes the assignee's email too, and leaves an unassigned payload as it was", async () => {
			const channel = await addChannel(acme, "#incidents");
			const assigned = newIncident();
			const unassigned = newIncident();
			const withAssignee = (incident: typeof assigned, assignee: { email: string } | null) => {
				const notice = noticeFor(incident);
				return { ...notice, payload: { ...notice.payload, assignee } };
			};
			await stores.incidents.create(
				acme,
				assigned,
				[anAudit(acme)],
				withAssignee(assigned, { email: "alan@acme.example" }),
			);
			await stores.incidents.create(
				acme,
				unassigned,
				[anAudit(acme)],
				withAssignee(unassigned, null),
			);

			for (const delivery of await deliveriesOf(acme, channel)) {
				await stores.deliveries.deliver(acme, delivery.id, 200, at(5));
			}

			const stored = await deliveriesOf(acme, channel);
			expect(
				Object.fromEntries(
					stored.map((delivery) => [delivery.incidentId, delivery.payload.assignee]),
				),
			).toEqual({ [assigned.id]: { email: null }, [unassigned.id]: null });
			expect(JSON.stringify(stored)).not.toMatch(/(alan|grace)@acme\.example/);
		});

		it("keeps each occurrence of an event as its own delivery, and a repeat of one as one", async () => {
			const channel = await addChannel(acme, "#incidents");
			const incident = newIncident();
			await stores.incidents.create(acme, incident, [anAudit(acme)]);
			const reassigned = (occurrence: number) => ({
				...noticeFor(incident, "incident.reassigned"),
				occurrence,
			});

			for (const occurrence of [1, 2, 2]) {
				await stores.incidents.update(
					acme,
					incident.id,
					{ status: "open", assigneeId: null },
					{},
					anAudit(acme),
					reassigned(occurrence),
				);
			}

			const stored = await deliveriesOf(acme, channel);
			expect(stored.map((delivery) => delivery.occurrence).sort()).toEqual([1, 2]);
		});

		it("marks a delivery failed with its reason and removes the actor's email", async () => {
			const channel = await addChannel(acme, "#incidents");
			const delivery = await oneDelivery(channel);

			await stores.deliveries.fail(acme, delivery.id, {
				reason: "rejected",
				status: 404,
				error: "HTTP 404",
			});
			await stores.deliveries.deliver(acme, delivery.id, 200, at(5));

			const [stored] = await deliveriesOf(acme, channel);
			expect(stored).toMatchObject({
				state: "failed",
				failureReason: "rejected",
				lastStatus: 404,
				lastError: "HTTP 404",
				deliveredAt: null,
			});
			expect(JSON.stringify(stored)).not.toContain("grace@acme.example");
		});

		it("schedules a retry, giving back the attempt when it is not counted", async () => {
			const channel = await addChannel(acme, "#incidents");
			const delivery = await oneDelivery(channel);
			await stores.deliveries.startAttempt(acme, delivery.id, at(1), at(60_000));

			await stores.deliveries.retry(acme, delivery.id, {
				retryAt: at(5000),
				counted: true,
				status: 503,
				error: "HTTP 503",
			});
			expect((await deliveriesOf(acme, channel))[0]).toMatchObject({
				attempts: 1,
				nextAttemptAt: at(5000),
				lastStatus: 503,
				state: "pending",
			});

			await stores.deliveries.startAttempt(acme, delivery.id, at(5000), at(65_000));
			await stores.deliveries.retry(acme, delivery.id, {
				retryAt: at(30_000),
				counted: false,
				status: 429,
				error: "rate limited",
			});
			expect((await deliveriesOf(acme, channel))[0]).toMatchObject({
				attempts: 1,
				nextAttemptAt: at(30_000),
				lastStatus: 429,
				payload: delivery.payload,
			});
		});
	});

	it("lists a channel's deliveries newest first, with a total, for its tenant only", async () => {
		const channel = await addChannel(acme, "#incidents");
		const incident = newIncident();
		await stores.incidents.create(acme, incident, [anAudit(acme)], noticeFor(incident));
		await stores.incidents.update(
			acme,
			incident.id,
			{ status: "open", assigneeId: null },
			{ status: "acknowledged" },
			anAudit(acme),
			noticeFor(incident, "incident.acknowledged", at(1000)),
		);

		const page = await stores.deliveries.listForChannel(acme, channel.id, { limit: 1, offset: 0 });

		expect(page.total).toBe(2);
		expect(page.items.map((d) => d.event)).toEqual(["incident.acknowledged"]);
		expect(await stores.deliveries.listForChannel(globex, channel.id, PAGE)).toEqual({
			items: [],
			total: 0,
		});
	});

	it("claims overdue pending deliveries across tenants, by their cutoff", async () => {
		const acmeChannel = await addChannel(acme, "#incidents");
		const globexChannel = await addChannel(globex, "#incidents");
		const unsent = await oneDelivery(acmeChannel);
		const sentIncident = newIncident();
		await stores.incidents.create(globex, sentIncident, [anAudit(globex)], noticeFor(sentIncident));
		const [sent] = await deliveriesOf(globex, globexChannel);
		await stores.deliveries.markSent(globex, sent?.id ?? "", at());

		// Only the unsent one is overdue by its cutoff.
		const claimed = await stores.deliveries.claimOverdue(
			{ unsentBefore: at(1), sentBefore: at(-1) },
			at(100),
			10,
		);
		expect(claimed).toEqual([{ tenantId: acme, deliveryId: unsent.id }]);
		// Claiming moved it to `now`, so it is not claimed again before its next cutoff.
		expect(
			await stores.deliveries.claimOverdue(
				{ unsentBefore: at(1), sentBefore: at(-1) },
				at(200),
				10,
			),
		).toEqual([]);
		expect(
			await stores.deliveries.claimOverdue(
				{ unsentBefore: at(1000), sentBefore: at(1000) },
				at(2000),
				10,
			),
		).toHaveLength(2);
	});

	it("purges deliveries created before the cutoff, in batches", async () => {
		const channel = await addChannel(acme, "#incidents");
		for (const offset of [0, 1000, 2000]) {
			const incident = newIncident();
			await stores.incidents.create(
				acme,
				incident,
				[anAudit(acme)],
				noticeFor(incident, "incident.opened", at(offset)),
			);
		}

		expect(await stores.deliveries.purgeOlderThan(at(1500), 1)).toBe(1);
		expect(await stores.deliveries.purgeOlderThan(at(1500), 10)).toBe(1);
		expect((await deliveriesOf(acme, channel)).map((d) => d.createdAt)).toEqual([at(2000)]);
	});
});
