import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAesGcmSecretBox } from "../src/adapters/aesGcmSecretBox";
import {
	channelSecretContext,
	type NotificationChannel,
	type NotificationChannelRepository,
} from "../src/domain/notifications/types";
import type { Principal, TenantId } from "../src/domain/shared/identity";
import { InMemoryNotificationChannelRepository } from "../src/repository/notifications/inMemoryNotificationChannelRepository";
import { PostgresNotificationChannelRepository } from "../src/repository/notifications/postgresNotificationChannelRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { createNotificationChannelService } from "../src/services/notifications/notificationChannelService";

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema, so the account parity test's TRUNCATE of tenants, which runs
// in parallel, never deletes rows these tests rely on.
const SCHEMA = "notification_parity";
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

// Real tenants, because notification_channels references tenants.
const newTenant = async (): Promise<TenantId> => {
	const id = randomUUID() as TenantId;
	await pool.query("INSERT INTO tenants (id, name, created_at) VALUES ($1, $2, now())", [
		id,
		"Acme",
	]);
	return id;
};

const newChannel = (
	name: string,
	createdAt = new Date("2026-01-01T00:00:00.123Z"),
): Omit<NotificationChannel, "tenantId"> => ({
	id: randomUUID(),
	kind: "slack_webhook",
	name,
	targetCiphertext: Buffer.from([1, 2, 3, 4]),
	targetHint: "WXYZ",
	minSeverity: "sev2",
	enabled: true,
	createdAt,
});

describe.each([
	["in-memory", () => new InMemoryNotificationChannelRepository()],
	["postgres", () => new PostgresNotificationChannelRepository(pool)],
] as const)("NotificationChannelRepository parity: %s", (_name, make) => {
	let repository: NotificationChannelRepository;
	let acme: TenantId;
	let globex: TenantId;

	beforeEach(async () => {
		repository = make();
		acme = await newTenant();
		globex = await newTenant();
	});

	it("round-trips every field", async () => {
		const channel = newChannel("#incidents");

		const created = await repository.create(acme, channel);

		expect(created).toEqual({ ...channel, tenantId: acme });
		expect((await repository.list(acme, { limit: 10, offset: 0 })).items).toEqual([created]);
	});

	it("refuses a duplicate name in the same tenant, but allows it in another", async () => {
		await repository.create(acme, newChannel("#incidents"));

		expect(await repository.create(acme, newChannel("#incidents"))).toBeNull();
		expect(await repository.create(globex, newChannel("#incidents"))).not.toBeNull();
	});

	it("lets exactly one of many concurrent same-name creates win", async () => {
		const results = await Promise.all(
			Array.from({ length: 10 }, () => repository.create(acme, newChannel("#race"))),
		);

		expect(results.filter((result) => result !== null)).toHaveLength(1);
	});

	it("lists only the tenant's channels, oldest first, with a total", async () => {
		const second = newChannel("#b", new Date("2026-01-02T00:00:00Z"));
		const first = newChannel("#a", new Date("2026-01-01T00:00:00Z"));
		await repository.create(acme, second);
		await repository.create(acme, first);
		await repository.create(globex, newChannel("#other"));

		const page = await repository.list(acme, { limit: 1, offset: 0 });

		expect(page.total).toBe(2);
		expect(page.items.map((item) => item.name)).toEqual(["#a"]);
		expect((await repository.list(acme, { limit: 10, offset: 5 })).items).toEqual([]);
	});
});

describe("notification channel storage in postgres", () => {
	const box = createAesGcmSecretBox(Buffer.alloc(32, 3).toString("base64"));
	const url = "https://hooks.slack.com/services/T000/B000/topSecretPart";

	it("stores only ciphertext, which opens only under its own tenant and channel", async () => {
		const tenantId = await newTenant();
		const principal: Principal = { tenantId, userId: "user-1", role: "admin" };
		const service = createNotificationChannelService(
			new PostgresNotificationChannelRepository(pool),
			box,
		);

		const created = await service.create(principal, {
			name: "#incidents",
			webhookUrl: url,
			minSeverity: "sev4",
			enabled: true,
		});
		if (!created.ok) throw new Error("create failed");

		const { rows } = await pool.query<{ target_ciphertext: Buffer; target_hint: string }>(
			"SELECT target_ciphertext, target_hint FROM notification_channels WHERE tenant_id = $1",
			[tenantId],
		);
		const raw = rows[0]?.target_ciphertext ?? Buffer.alloc(0);

		expect(raw.includes(url)).toBe(false);
		expect(raw.includes("topSecretPart")).toBe(false);
		expect(rows[0]?.target_hint).toBe("Part");
		expect(box.open(raw, channelSecretContext(tenantId, created.value.id))).toBe(url);
		expect(() =>
			box.open(raw, channelSecretContext(randomUUID() as TenantId, created.value.id)),
		).toThrow();
		expect(() => box.open(raw, channelSecretContext(tenantId, randomUUID()))).toThrow();
	});
});
