import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { STREAM_RETRY_MS } from "../contract/events";
import type { EventHub } from "../domain/events/types";
import type { AppEnv } from "../http/types";
import { toStreamMessage } from "../mappers/events";

// Spec: docs/features/realtime-status.md
export const STREAM_HEARTBEAT_MS = 25_000;

export const eventRoutes = (hub: EventHub, heartbeatMs = STREAM_HEARTBEAT_MS) =>
	new Hono<AppEnv>().get("/", (c) => {
		// The token was checked from the Authorization header only, by requireAuth.
		const principal = c.get("principal");
		return streamSSE(c, async (stream) => {
			let finish = () => {};
			const finished = new Promise<void>((resolve) => {
				finish = resolve;
			});
			let first = true;
			const disconnect = hub.connect(principal, {
				async write(event) {
					const { name, data } = toStreamMessage(event);
					await stream.writeSSE({
						event: name,
						data: JSON.stringify(data),
						// Sent once: how long the client waits before reconnecting.
						...(first ? { retry: STREAM_RETRY_MS } : {}),
					});
					first = false;
				},
				close: finish,
			});
			// A comment line keeps proxies from closing an idle stream. Hono's write never rejects:
			// a client that went away is noticed through onAbort below.
			const heartbeat = setInterval(() => {
				void stream.write(": heartbeat\n\n");
			}, heartbeatMs);
			stream.onAbort(disconnect);
			await finished;
			clearInterval(heartbeat);
		});
	});
