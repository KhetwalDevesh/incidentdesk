import { Pool } from "pg";
import { loadDatabaseConfig } from "../src/config";
import { runMigrations } from "../src/repository/postgres/migrate";

const pool = new Pool({ connectionString: loadDatabaseConfig().DATABASE_URL });

try {
	const applied = await runMigrations(pool);
	console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "No pending migrations");
} finally {
	await pool.end();
}
