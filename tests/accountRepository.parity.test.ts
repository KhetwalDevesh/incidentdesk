import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AccountRepository, CredentialStore, Tenant, User } from "../src/domain/auth/types";
import type { TenantId } from "../src/domain/shared/identity";
import { InMemoryAccountRepository } from "../src/repository/accounts/inMemoryAccountRepository";
import { PostgresAccountRepository } from "../src/repository/accounts/postgresAccountRepository";
import { runMigrations } from "../src/repository/postgres/migrate";
import { anAudit, setupAudit } from "./auditEntries";

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
			await pool.query(
				"TRUNCATE alerts, alert_sources, notification_deliveries, notification_channels, password_setup_tokens, users, tenants",
			);
		}
		repository = make();
		tenant = newTenant();
		admin = newUser("ada@example.com", { role: "admin", passwordHash: "hash-ada" });
		await repository.createTenantWithAdmin(tenant, admin, anAudit(tenant.id, "tenant.created"));
	});

	it("creates a tenant with its admin, findable by email and by id", async () => {
		const expected = { ...admin, tenantId: tenant.id };

		expect(await repository.findUserByEmail("ada@example.com")).toEqual(expected);
		expect(await repository.findUser(tenant.id, admin.id)).toEqual(expected);
	});

	it("refuses a second signup with the same email, and creates nothing", async () => {
		const other = newTenant();

		expect(
			await repository.createTenantWithAdmin(
				other,
				newUser("ada@example.com"),
				anAudit(other.id, "tenant.created"),
			),
		).toBe(false);
		expect((await repository.listUsers(other.id, { limit: 10, offset: 0 })).total).toBe(0);
	});

	it("hides a user from another tenant", async () => {
		const other = newTenant();
		await repository.createTenantWithAdmin(
			other,
			newUser("linus@example.com"),
			anAudit(other.id, "tenant.created"),
		);

		expect(await repository.findUser(other.id, admin.id)).toBeNull();
	});

	it("adds a pending member and lists the tenant's users oldest first", async () => {
		const grace = newUser("grace@example.com", { createdAt: NOW });

		expect(
			await repository.addUser(
				tenant.id,
				grace,
				{ tokenHash: "t1", expiresAt: LATER },
				anAudit(tenant.id, "member.invited"),
			),
		).toBe(true);

		const page = await repository.listUsers(tenant.id, { limit: 1, offset: 1 });
		expect(page).toEqual({ items: [{ ...grace, tenantId: tenant.id }], total: 2 });
	});

	it("refuses to add a registered email, and stores no setup token", async () => {
		const added = await repository.addUser(
			tenant.id,
			newUser("ada@example.com"),
			{
				tokenHash: "t1",
				expiresAt: LATER,
			},
			anAudit(tenant.id, "member.invited"),
		);

		expect(added).toBe(false);
		expect(await repository.redeemSetupToken("t1", NOW, "hash", setupAudit)).toBeNull();
	});

	it("redeems a setup token once, setting the password", async () => {
		const grace = newUser("grace@example.com");
		await repository.addUser(
			tenant.id,
			grace,
			{ tokenHash: "t1", expiresAt: LATER },
			anAudit(tenant.id, "member.invited"),
		);

		const redeemed = await repository.redeemSetupToken("t1", NOW, "hash-grace", setupAudit);

		expect(redeemed).toEqual({ ...grace, tenantId: tenant.id, passwordHash: "hash-grace" });
		expect(await repository.redeemSetupToken("t1", NOW, "hash-again", setupAudit)).toBeNull();
		expect((await repository.findUser(tenant.id, grace.id))?.passwordHash).toBe("hash-grace");
	});

	it("refuses an expired setup token", async () => {
		await repository.addUser(
			tenant.id,
			newUser("grace@example.com"),
			{
				tokenHash: "t1",
				expiresAt: NOW,
			},
			anAudit(tenant.id, "member.invited"),
		);

		expect(await repository.redeemSetupToken("t1", NOW, "hash", setupAudit)).toBeNull();
	});

	it("lets exactly one of many concurrent redemptions win", async () => {
		await repository.addUser(
			tenant.id,
			newUser("grace@example.com"),
			{
				tokenHash: "t1",
				expiresAt: LATER,
			},
			anAudit(tenant.id, "member.invited"),
		);

		const results = await Promise.all(
			Array.from({ length: 10 }, (_, n) =>
				repository.redeemSetupToken("t1", NOW, `hash-${n}`, setupAudit),
			),
		);

		expect(results.filter((result) => result !== null)).toHaveLength(1);
	});

	describe("member changes", () => {
		const roleAudit = (before: User) =>
			anAudit(tenant.id, "member.role_changed", { resource: { type: "user", id: before.id } });
		const removeAudit = (removed: User) =>
			anAudit(tenant.id, "member.removed", { resource: { type: "user", id: removed.id } });
		const add = async (
			email: string,
			overrides: Partial<Omit<User, "tenantId">> = {},
			tokenHash: string = randomUUID(),
		) => {
			const user = newUser(email, overrides);
			await repository.addUser(
				tenant.id,
				user,
				{ tokenHash, expiresAt: LATER },
				anAudit(tenant.id, "member.invited"),
			);
			return user;
		};
		const roles = async () =>
			Object.fromEntries(
				(await repository.listUsers(tenant.id, { limit: 50, offset: 0 })).items.map((user) => [
					user.email,
					user.role,
				]),
			);

		it("changes roles all at once, returns members in request order, and audits only real changes", async () => {
			const grace = await add("grace@example.com", { role: "responder", passwordHash: "h" });
			const linus = await add("linus@example.com");
			let audited = 0;

			const outcome = await repository.changeRoles(
				tenant.id,
				[
					{ userId: linus.id, role: "admin" },
					{ userId: grace.id, role: "responder" },
				],
				(before) => {
					audited += 1;
					return roleAudit(before);
				},
			);

			expect(outcome).toMatchObject({
				applied: true,
				users: [
					{ id: linus.id, role: "admin", passwordHash: null },
					{ id: grace.id, role: "responder" },
				],
			});
			expect(audited).toBe(1);
			expect(await roles()).toMatchObject({
				"linus@example.com": "admin",
				"grace@example.com": "responder",
			});
		});

		it("refuses a batch naming an unknown or another tenant's id, listing each, and changes nothing", async () => {
			const grace = await add("grace@example.com");
			const other = newTenant();
			const stranger = newUser("stranger@example.com");
			await repository.createTenantWithAdmin(other, stranger, anAudit(other.id, "tenant.created"));

			const changed = await repository.changeRoles(
				tenant.id,
				[
					{ userId: grace.id, role: "admin" },
					{ userId: randomUUID(), role: "admin" },
					{ userId: stranger.id, role: "viewer" },
				],
				roleAudit,
			);
			const removed = await repository.removeUsers(tenant.id, [stranger.id, grace.id], removeAudit);

			expect(changed).toEqual({
				applied: false,
				rejection: { reason: "not_found", indexes: [1, 2] },
			});
			expect(removed).toEqual({ applied: false, rejection: { reason: "not_found", indexes: [0] } });
			expect(await roles()).toMatchObject({ "grace@example.com": "viewer" });
			expect(await repository.findUser(other.id, stranger.id)).not.toBeNull();
		});

		it("removes users with their setup tokens, and frees their emails", async () => {
			const pending = await add("grace@example.com", {}, "token-grace");
			const active = await add("linus@example.com", { passwordHash: "h" });

			const outcome = await repository.removeUsers(tenant.id, [pending.id, active.id], removeAudit);

			expect(outcome).toMatchObject({
				applied: true,
				users: [{ id: pending.id }, { id: active.id }],
			});
			expect(await repository.findUser(tenant.id, active.id)).toBeNull();
			expect(await repository.redeemSetupToken("token-grace", NOW, "hash", setupAudit)).toBeNull();
			expect(await add("grace@example.com")).toBeDefined();
			expect(Object.keys(await roles()).sort()).toEqual(["ada@example.com", "grace@example.com"]);
		});

		it("never leaves the tenant without an active admin, and a pending admin does not count", async () => {
			await add("pending-admin@example.com", { role: "admin" });
			const responder = await add("grace@example.com", { role: "responder", passwordHash: "h" });

			expect(await repository.removeUsers(tenant.id, [admin.id], removeAudit)).toEqual({
				applied: false,
				rejection: { reason: "last_admin" },
			});
			expect(
				await repository.changeRoles(tenant.id, [{ userId: admin.id, role: "viewer" }], roleAudit),
			).toEqual({
				applied: false,
				rejection: { reason: "last_admin" },
			});
			// Promoting an active member in the same batch keeps an admin, so this applies.
			const swap = await repository.changeRoles(
				tenant.id,
				[
					{ userId: admin.id, role: "viewer" },
					{ userId: responder.id, role: "admin" },
				],
				roleAudit,
			);

			expect(swap.applied).toBe(true);
			expect(await roles()).toMatchObject({
				"ada@example.com": "viewer",
				"grace@example.com": "admin",
			});
		});

		it("lets only one of two admins removing each other at once succeed", async () => {
			const grace = await add("grace@example.com", { role: "admin", passwordHash: "h" });

			const outcomes = await Promise.all([
				repository.removeUsers(tenant.id, [grace.id], removeAudit),
				repository.removeUsers(tenant.id, [admin.id], removeAudit),
			]);

			expect(outcomes.map((outcome) => outcome.applied).sort()).toEqual([false, true]);
			expect(outcomes.find((outcome) => !outcome.applied)).toEqual({
				applied: false,
				rejection: { reason: "last_admin" },
			});
			const left = (await repository.listUsers(tenant.id, { limit: 10, offset: 0 })).items;
			expect(left.filter((user) => user.role === "admin")).toHaveLength(1);
		});
	});
});
