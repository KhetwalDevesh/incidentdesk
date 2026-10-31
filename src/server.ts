import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { buildApp } from "./containers";

const config = loadConfig();

serve({ fetch: buildApp(config).fetch, port: config.PORT }, ({ port }) => {
	console.log(`IncidentDesk API listening on http://localhost:${port}`);
});
