import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

	// Spec: docs/features/on-call-schedules.md. 0013 is the expand step that removes viewers.
	it("turns every viewer into a responder, auditing each change with no actor", async () => {
		const real = resolve(import.meta.dirname, "../db/migrations");
		const files = (await readdir(real)).filter((name) => name.endsWith(".sql")).sort();
		const upTo = async (last: string) =>
			migrationsDir(
				Object.fromEntries(
					await Promise.all(
						files
							.filter((name) => name <= last)
							.map(async (name) => [name, await readFile(join(real, name), "utf8")]),
					),
				),
			);
		await runMigrations(pool, await upTo("0012_create_on_call_schedules.sql"));
		const tenant = "00000000-0000-4000-8000-0000000000aa";
		await pool.query("INSERT INTO tenants (id, name, created_at) VALUES ($1, 'Acme', now())", [
			tenant,
		]);
		const users: [string, string][] = [
			["00000000-0000-4000-8000-000000000001", "viewer"],
			["00000000-0000-4000-8000-000000000002", "responder"],
			["00000000-0000-4000-8000-000000000003", "admin"],
		];
		for (const [id, role] of users) {
			await pool.query(
				"INSERT INTO users (tenant_id, id, email, role, created_at) VALUES ($1, $2, $3, $4, now())",
				[tenant, id, `${role}@acme.example`, role],
			);
		}

		await runMigrations(pool, await upTo("0013_remove_viewer_role.sql"));

		const roles = await pool.query("SELECT id, role FROM users ORDER BY id");
		expect(roles.rows.map((row) => row.role)).toEqual(["responder", "responder", "admin"]);
		const audit = await pool.query(
			"SELECT tenant_id, actor_type, actor_id, action, resource_type, resource_id, details FROM audit_events",
		);
		expect(audit.rows).toEqual([
			{
				tenant_id: tenant,
				actor_type: "anonymous",
				actor_id: null,
				action: "member.role_changed",
				resource_type: "user",
				resource_id: "00000000-0000-4000-8000-000000000001",
				details: { from: "viewer", to: "responder" },
			},
		]);
	});
});
