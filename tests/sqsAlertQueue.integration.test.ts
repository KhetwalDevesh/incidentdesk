import { randomUUID } from "node:crypto";
import { SQSClient } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { createSqsQueue } from "../src/adapters/sqsQueue";
import { type AlertQueueMessage, alertQueueBody } from "../src/domain/alerts/types";
import type { TenantId } from "../src/domain/shared/identity";

// Runs only through `pnpm test:sqs`, against a real SQS queue that no worker reads.
// Create one with: pnpm sqs:setup --name incidentdesk-alerts-<you>-test --region <region>
const queueUrl = process.env.TEST_ALERT_QUEUE_URL;
const region = process.env.AWS_REGION;
if (!queueUrl || !region) {
	throw new Error(
		"Set TEST_ALERT_QUEUE_URL and AWS_REGION in .env, and AWS_PROFILE to a profile with access to that queue",
	);
}

const queue = createSqsQueue(new SQSClient({ region }), queueUrl, alertQueueBody);
const tenantId = randomUUID() as TenantId;

// SQS is eventually consistent and gives no ordering, so wait up to `withinMs` for our message.
// Leftovers from an earlier, interrupted run are deleted on the way.
const receiveFor = async (alertId: string, withinMs: number): Promise<AlertQueueMessage | null> => {
	const deadline = Date.now() + withinMs;
	while (Date.now() < deadline) {
		const waitSeconds = Math.max(1, Math.min(20, Math.floor((deadline - Date.now()) / 1000)));
		for (const message of await queue.receive(10, waitSeconds)) {
			if (JSON.parse(message.body).alertId === alertId) return message;
			await queue.delete(message);
		}
	}
	return null;
};

describe("SQS alert queue against AWS", () => {
	it("sends only the ids and receives them back", async () => {
		const alertId = randomUUID();

		await queue.send({ tenantId, alertId });
		const message = await receiveFor(alertId, 20_000);

		expect(message).not.toBeNull();
		expect(JSON.parse(message?.body ?? "null")).toEqual({ tenantId, alertId });
		await queue.delete(message as AlertQueueMessage);
	});

	it("hides a message after retryAfter, then redelivers it once the delay passes", async () => {
		const alertId = randomUUID();
		await queue.send({ tenantId, alertId });
		const first = (await receiveFor(alertId, 20_000)) as AlertQueueMessage;

		// The queue's 60 s visibility timeout is replaced by 3 s from now.
		await queue.retryAfter(first, 3000);
		const again = await receiveFor(alertId, 20_000);

		expect(again).not.toBeNull();
		expect(again?.id).toBe(first.id);
		expect(again?.receipt).not.toBe(first.receipt);
		await queue.delete(again as AlertQueueMessage);
	});

	it("deletes a message, after which its receipt no longer works", async () => {
		const alertId = randomUUID();
		await queue.send({ tenantId, alertId });
		const message = (await receiveFor(alertId, 20_000)) as AlertQueueMessage;

		await queue.delete(message);

		await expect(queue.retryAfter(message, 0)).rejects.toThrow();
	});
});
