import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { buildApp } from "./containers";

const config = loadConfig();
const { app, pool } = buildApp(config);

// An idle client can drop, for example when Postgres restarts. Without a listener that crashes the process.
pool.on("error", (error) => console.error("Idle Postgres client error:", error.message));

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
	console.log(`IncidentDesk API listening on http://localhost:${port}`);
});

const shutdown = () => server.close(() => void pool.end());
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
