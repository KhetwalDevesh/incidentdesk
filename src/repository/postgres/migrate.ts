import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
// Any constant unique to this app. Serializes runners so two deploys cannot apply a file twice.
const LOCK_KEY = 7_405_100;

// Applies pending files in name order, each in its own transaction. Returns the files applied.
export const runMigrations = async (pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> => {
	const files = (await readdir(dir)).filter((file) => MIGRATION_FILE.test(file)).sort();
	const client = await pool.connect();
	try {
		await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
		await client.query(
			"CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
		);
		const { rows } = await client.query<{ version: string }>(
			"SELECT version FROM schema_migrations",
		);
		const applied = new Set(rows.map((row) => row.version));

		const ran: string[] = [];
		for (const file of files) {
			if (applied.has(file)) continue;
			const sql = await readFile(join(dir, file), "utf8");
			await client.query("BEGIN");
			try {
				await client.query(sql);
				await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			}
			ran.push(file);
		}
		return ran;
	} finally {
		await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
		client.release();
	}
};
