import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config";
import { buildWorker } from "./containers";

// Polls the alert queue and groups alerts into incidents.
// Spec: docs/features/alert-ingestion.md. Run several for throughput: claims never overlap.
const IDLE_POLL_MS = 1000;
const ERROR_BACKOFF_MS = 5000;

const config = loadConfig();
// The id only: alert content is untrusted and stays out of logs.
const { processor, pool } = buildWorker(config, (alertId, error) =>
	console.error(
		`Alert ${alertId} failed:`,
		error instanceof Error ? error.message : "unknown error",
	),
);
pool.on("error", (error) => console.error("Idle Postgres client error:", error.message));

const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

console.log("IncidentDesk alert worker started");
while (!stop.signal.aborted) {
	try {
		// A full batch means more may be waiting, so poll again at once.
		const claimed = await processor.processBatch();
		if (claimed === 0) await sleep(IDLE_POLL_MS, undefined, { signal: stop.signal });
	} catch (error) {
		if (stop.signal.aborted) break;
		console.error("Alert batch failed:", error instanceof Error ? error.message : "unknown error");
		await sleep(ERROR_BACKOFF_MS, undefined, { signal: stop.signal }).catch(() => undefined);
	}
}
// The current batch finished above, so nothing is left half done.
await pool.end();
console.log("IncidentDesk alert worker stopped");
