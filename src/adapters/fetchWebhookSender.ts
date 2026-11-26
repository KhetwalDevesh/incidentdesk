import type { WebhookResult, WebhookSender } from "../domain/notifications/types";

export type FetchWebhookSenderOptions = {
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
};

// POSTs JSON to a webhook. Spec: docs/features/slack-delivery.md.
// - A redirect is returned as its 3xx status, never followed, so an allowed host cannot bounce
//   the request to an internal address.
// - Errors are reduced to a fixed description: a library's message can include the URL,
//   which is a secret.
export const createFetchWebhookSender = ({
	timeoutMs = 5000,
	fetch = globalThis.fetch,
}: FetchWebhookSenderOptions = {}): WebhookSender => ({
	async post(url, body): Promise<WebhookResult> {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
			});
			// The body is never read: Slack's text is not stored or returned. Cancelling frees the socket.
			await response.body?.cancel().catch(() => undefined);
			return {
				kind: "response",
				status: response.status,
				retryAfter: response.headers.get("retry-after"),
			};
		} catch (error) {
			const timedOut =
				error instanceof DOMException &&
				(error.name === "TimeoutError" || error.name === "AbortError");
			return { kind: "error", error: timedOut ? "timeout" : "network error" };
		}
	},
});
