import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config";
import { buildWorker } from "./containers";

// Receives alert messages from SQS and groups the alerts into incidents, and sweeps overdue
// alerts back onto the queue. Spec: docs/features/alert-queue-sqs.md.
// Run several for throughput: SQS hides a received message from other workers.
const SWEEP_INTERVAL_MS = 30_000;
const ERROR_BACKOFF_MS = 5000;

const config = loadConfig();
// Ids only: alert content is untrusted and stays out of logs.
const { processor, pool } = buildWorker(config, (subject, error) =>
	console.error(`${subject} failed:`, error instanceof Error ? error.message : "unknown error"),
);
pool.on("error", (error) => console.error("Idle Postgres client error:", error.message));

const stop = new AbortController();
process.on("SIGINT", () => stop.abort());
process.on("SIGTERM", () => stop.abort());

// Runs `work` until stopped, pausing `idleMs` after each run and backing off after a failure.
const loop = async (name: string, work: () => Promise<unknown>, idleMs: number) => {
	while (!stop.signal.aborted) {
		try {
			await work();
			if (idleMs > 0) await sleep(idleMs, undefined, { signal: stop.signal });
		} catch (error) {
			if (stop.signal.aborted) break;
			console.error(`${name} failed:`, error instanceof Error ? error.message : "unknown error");
			await sleep(ERROR_BACKOFF_MS, undefined, { signal: stop.signal }).catch(() => undefined);
		}
	}
};

console.log("IncidentDesk alert worker started");
// receive() long-polls, so the message loop needs no pause of its own.
await Promise.all([
	loop("Alert batch", () => processor.processMessages(), 0),
	loop("Alert sweep", () => processor.sweep(), SWEEP_INTERVAL_MS),
]);
// The current batch finished above, so nothing is left half done. Messages not reached
// become visible again after the visibility timeout.
await pool.end();
console.log("IncidentDesk alert worker stopped");
