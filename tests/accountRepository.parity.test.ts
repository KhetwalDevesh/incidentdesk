import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AccountRepository, CredentialStore, Tenant, User } from "../src/domain/auth/types";
import type { TenantId } from "../src/domain/shared/identity";
import { InMemoryAccountRepository } from "../src/repository/accounts/inMemoryAccountRepository";
import { PostgresAccountRepository } from "../src/repository/accounts/postgresAccountRepository";
import { runMigrations } from "../src/repository/postgres/migrate";

// Matches docker-compose.yml. CI sets TEST_DATABASE_URL to its own service.
const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

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

const newTenant = (): Tenant => ({
	id: randomUUID() as TenantId,
	name: "Acme",
	createdAt: new Date("2026-01-01T00:00:00Z"),
});

const newUser = (
	email: string,
	overrides: Partial<Omit<User, "tenantId">> = {},
): Omit<User, "tenantId"> => ({
	id: randomUUID(),
	email,
	role: "viewer",
	passwordHash: null,
	createdAt: new Date("2026-01-01T00:00:00.123Z"),
	...overrides,
});

const NOW = new Date("2026-01-02T00:00:00Z");
const LATER = new Date("2026-01-05T00:00:00Z");

describe.each([
	["in-memory", () => new InMemoryAccountRepository()],
	["postgres", () => new PostgresAccountRepository(pool)],
] as const)("AccountRepository parity: %s", (name, make) => {
	let repository: AccountRepository & CredentialStore;
	let tenant: Tenant;
	let admin: Omit<User, "tenantId">;

	beforeEach(async () => {
		if (name === "postgres") {
			await pool.query("TRUNCATE notification_channels, password_setup_tokens, users, tenants");
		}
		repository = make();
		tenant = newTenant();
		admin = newUser("ada@example.com", { role: "admin", passwordHash: "hash-ada" });
		await repository.createTenantWithAdmin(tenant, admin);
	});

	it("creates a tenant with its admin, findable by email and by id", async () => {
		const expected = { ...admin, tenantId: tenant.id };

		expect(await repository.findUserByEmail("ada@example.com")).toEqual(expected);
		expect(await repository.findUser(tenant.id, admin.id)).toEqual(expected);
	});

	it("refuses a second signup with the same email, and creates nothing", async () => {
		const other = newTenant();

		expect(await repository.createTenantWithAdmin(other, newUser("ada@example.com"))).toBe(false);
		expect((await repository.listUsers(other.id, { limit: 10, offset: 0 })).total).toBe(0);
	});

	it("hides a user from another tenant", async () => {
		const other = newTenant();
		await repository.createTenantWithAdmin(other, newUser("linus@example.com"));

		expect(await repository.findUser(other.id, admin.id)).toBeNull();
	});

	it("adds a pending member and lists the tenant's users oldest first", async () => {
		const grace = newUser("grace@example.com", { createdAt: NOW });

		expect(await repository.addUser(tenant.id, grace, { tokenHash: "t1", expiresAt: LATER })).toBe(
			true,
		);

		const page = await repository.listUsers(tenant.id, { limit: 1, offset: 1 });
		expect(page).toEqual({ items: [{ ...grace, tenantId: tenant.id }], total: 2 });
	});

	it("refuses to add a registered email, and stores no setup token", async () => {
		const added = await repository.addUser(tenant.id, newUser("ada@example.com"), {
			tokenHash: "t1",
			expiresAt: LATER,
		});

		expect(added).toBe(false);
		expect(await repository.redeemSetupToken("t1", NOW, "hash")).toBeNull();
	});

	it("redeems a setup token once, setting the password", async () => {
		const grace = newUser("grace@example.com");
		await repository.addUser(tenant.id, grace, { tokenHash: "t1", expiresAt: LATER });

		const redeemed = await repository.redeemSetupToken("t1", NOW, "hash-grace");

		expect(redeemed).toEqual({ ...grace, tenantId: tenant.id, passwordHash: "hash-grace" });
		expect(await repository.redeemSetupToken("t1", NOW, "hash-again")).toBeNull();
		expect((await repository.findUser(tenant.id, grace.id))?.passwordHash).toBe("hash-grace");
	});

	it("refuses an expired setup token", async () => {
		await repository.addUser(tenant.id, newUser("grace@example.com"), {
			tokenHash: "t1",
			expiresAt: NOW,
		});

		expect(await repository.redeemSetupToken("t1", NOW, "hash")).toBeNull();
	});

	it("lets exactly one of many concurrent redemptions win", async () => {
		await repository.addUser(tenant.id, newUser("grace@example.com"), {
			tokenHash: "t1",
			expiresAt: LATER,
		});

		const results = await Promise.all(
			Array.from({ length: 10 }, (_, n) => repository.redeemSetupToken("t1", NOW, `hash-${n}`)),
		);

		expect(results.filter((result) => result !== null)).toHaveLength(1);
	});
});
