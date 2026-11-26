import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { buildApp } from "./containers";

const config = loadConfig();
// Ids only: alert content is untrusted and stays out of logs.
const message = (error: unknown) => (error instanceof Error ? error.message : "unknown error");
const { app, pool, eventHub, feed } = buildApp(config, {
	onAlertSendError: (alertId, error) =>
		console.error(
			`Alert ${alertId} was saved but not queued; the sweeper will send it:`,
			message(error),
		),
	onDeliverySendError: (deliveryId, error) =>
		console.error(
			`Delivery ${deliveryId} was saved but not queued; the sweeper will send it:`,
			message(error),
		),
	onAuditError: (entryId, error) =>
		console.error(`Audit entry ${entryId} was not recorded:`, message(error)),
	onRealtimeError: (subject, error) => console.error(`Realtime ${subject} failed:`, message(error)),
});

// An idle client can drop, for example when Postgres restarts. Without a listener that crashes the process.
pool.on("error", (error) => console.error("Idle Postgres client error:", error.message));

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
	console.log(`IncidentDesk API listening on http://localhost:${port}`);
});

// Streams never end on their own, so close them first, or server.close waits for them.
const shutdown = () => {
	eventHub.shutdown();
	void feed.close();
	server.close(() => void pool.end());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
