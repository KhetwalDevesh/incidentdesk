import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/repository/postgres/migrate";

const TEST_DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://incidentdesk:incidentdesk@localhost:54329/incidentdesk_test";

// Its own schema, so these runs never touch the tables the parity test uses.
const SCHEMA = "migrate_test";
const admin = new Pool({ connectionString: TEST_DATABASE_URL });
const pool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${SCHEMA}` });

const migrationsDir = async (files: Record<string, string>) => {
	const dir = await mkdtemp(join(tmpdir(), "incidentdesk-migrations-"));
	for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
	return dir;
};

const tableExists = async (table: string) =>
	(await pool.query("SELECT to_regclass($1) AS found", [`${SCHEMA}.${table}`])).rows[0]?.found !==
	null;

describe("runMigrations", () => {
	beforeEach(async () => {
		await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
		await admin.query(`CREATE SCHEMA ${SCHEMA}`);
	});

	afterAll(async () => {
		await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
		await Promise.all([admin.end(), pool.end()]);
	});

	it("applies pending files in order, then skips them on a rerun", async () => {
		const dir = await migrationsDir({
			"0002_add_b.sql": "ALTER TABLE a ADD COLUMN b text;",
			"0001_create_a.sql": "CREATE TABLE a (id int);",
			"notes.md": "ignored",
		});

		expect(await runMigrations(pool, dir)).toEqual(["0001_create_a.sql", "0002_add_b.sql"]);
		expect(await runMigrations(pool, dir)).toEqual([]);
	});

	it("rolls back a failing file and does not record it", async () => {
		const dir = await migrationsDir({
			"0001_create_a.sql": "CREATE TABLE a (id int);",
			"0002_broken.sql": "CREATE TABLE half (id int); SELECT * FROM missing_table;",
		});

		await expect(runMigrations(pool, dir)).rejects.toThrow(/missing_table/);

		expect(await tableExists("a")).toBe(true);
		expect(await tableExists("half")).toBe(false);
		const { rows } = await pool.query("SELECT version FROM schema_migrations");
		expect(rows.map((row) => row.version)).toEqual(["0001_create_a.sql"]);
	});
});
