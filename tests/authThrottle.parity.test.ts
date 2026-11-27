import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LoginThrottle, ThrottleRule } from "../src/domain/auth/types";
import { InMemoryLoginThrottle } from "../src/repository/auth/inMemoryLoginThrottle";
import { PostgresLoginThrottle } from "../src/repository/auth/postgresLoginThrottle";
import { runMigrations } from "../src/repository/postgres/migrate";

// Spec: docs/features/login-rate-limiting.md

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema: the purge test deletes across every key.
const SCHEMA = "auth_throttle_parity";
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

const MINUTE = 60_000;
const RULE: ThrottleRule = { limit: 3, windowMs: 15 * MINUTE, lockMs: 10 * MINUTE };
const T0 = new Date("2026-01-10T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

describe.each([
	["in-memory", () => new InMemoryLoginThrottle()],
	["postgres", () => new PostgresLoginThrottle(pool)],
] as const)("login throttle parity: %s", (_name, make) => {
	let throttle: LoginThrottle;
	let key: string;

	beforeEach(async () => {
		// This schema belongs to this file alone, so emptying it is safe.
		if (_name === "postgres") await pool.query("TRUNCATE auth_throttle");
		throttle = make();
		key = `test:${randomUUID()}`;
	});

	it("counts events and locks the key when the count reaches the limit, once", async () => {
		const first = await throttle.record(key, RULE, at(0));
		const second = await throttle.record(key, RULE, at(1000));
		const third = await throttle.record(key, RULE, at(2000));
		const fourth = await throttle.record(key, RULE, at(3000));

		expect(first).toEqual({ count: 1, lockedUntil: null, lockedNow: false });
		expect(second).toEqual({ count: 2, lockedUntil: null, lockedNow: false });
		expect(third).toEqual({ count: 3, lockedUntil: at(2000 + 10 * MINUTE), lockedNow: true });
		// Already locked: the lock keeps its end, and is not started again.
		expect(fourth).toEqual({ count: 4, lockedUntil: at(2000 + 10 * MINUTE), lockedNow: false });
	});

	it("answers the latest lock among the keys, until it ends", async () => {
		const other = `test:${randomUUID()}`;
		for (const ms of [0, 1, 2]) await throttle.record(key, RULE, at(ms));
		for (const ms of [5000, 5001, 5002]) await throttle.record(other, RULE, at(ms));

		expect(await throttle.lockedUntil([key, other, "test:none"], at(6000))).toEqual(
			at(5002 + 10 * MINUTE),
		);
		expect(await throttle.lockedUntil([key], at(2 + 10 * MINUTE - 1))).toEqual(at(2 + 10 * MINUTE));
		expect(await throttle.lockedUntil([key], at(2 + 10 * MINUTE))).toBeNull();
		expect(await throttle.lockedUntil(["test:none"], at(0))).toBeNull();
	});

	it("starts a new window once the old one has passed", async () => {
		await throttle.record(key, RULE, at(0));
		await throttle.record(key, RULE, at(1000));

		const later = await throttle.record(key, RULE, at(15 * MINUTE));
		const next = await throttle.record(key, RULE, at(15 * MINUTE + 1));

		expect(later).toEqual({ count: 1, lockedUntil: null, lockedNow: false });
		expect(next.count).toBe(2);
	});

	it("can lock again after a lock ends", async () => {
		for (const ms of [0, 1, 2]) await throttle.record(key, RULE, at(ms));
		const start = 20 * MINUTE;

		const outcomes = [];
		for (const ms of [0, 1, 2]) outcomes.push(await throttle.record(key, RULE, at(start + ms)));

		expect(outcomes.at(-1)).toEqual({
			count: 3,
			lockedUntil: at(start + 2 + 10 * MINUTE),
			lockedNow: true,
		});
	});

	it("forgets a cleared key", async () => {
		await throttle.record(key, RULE, at(0));
		await throttle.record(key, RULE, at(1));

		await throttle.clear(key);

		expect(await throttle.record(key, RULE, at(2))).toMatchObject({ count: 1 });
	});

	it("counts every one of many concurrent events, and starts the lock exactly once", async () => {
		const outcomes = await Promise.all(
			Array.from({ length: 20 }, () => throttle.record(key, RULE, at(0))),
		);

		expect(outcomes.map((outcome) => outcome.count).sort((a, b) => a - b)).toEqual(
			Array.from({ length: 20 }, (_, n) => n + 1),
		);
		expect(outcomes.filter((outcome) => outcome.lockedNow)).toHaveLength(1);
	});

	it("purges keys idle and unlocked since the cutoff, in batches", async () => {
		const stale = [`test:${randomUUID()}`, `test:${randomUUID()}`];
		const locked = `test:${randomUUID()}`;
		const fresh = `test:${randomUUID()}`;
		for (const each of stale) await throttle.record(each, RULE, at(0));
		for (const ms of [0, 1, 2]) {
			await throttle.record(locked, { ...RULE, lockMs: 120 * MINUTE }, at(ms));
		}
		await throttle.record(fresh, RULE, at(90 * MINUTE));
		const cutoff = at(60 * MINUTE);

		const first = await throttle.purgeOlderThan(cutoff, 1);
		const rest = await throttle.purgeOlderThan(cutoff, 100);

		expect([first, rest]).toEqual([1, 1]);
		expect(await throttle.lockedUntil([locked], cutoff)).toEqual(at(2 + 120 * MINUTE));
		expect(await throttle.record(fresh, RULE, at(90 * MINUTE + 1))).toMatchObject({ count: 2 });
		for (const each of stale) {
			expect(await throttle.record(each, RULE, at(61 * MINUTE))).toMatchObject({ count: 1 });
		}
	});
});
