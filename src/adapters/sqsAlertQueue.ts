import {
	ChangeMessageVisibilityCommand,
	DeleteMessageCommand,
	ReceiveMessageCommand,
	SendMessageCommand,
	type SQSClient,
} from "@aws-sdk/client-sqs";
import type { AlertQueue, AlertQueueMessage, AlertRef } from "../domain/alerts/types";

// SQS caps receives at 10 messages, long polls at 20 s and visibility at 12 hours.
const MAX_RECEIVE = 10;
const MAX_WAIT_SECONDS = 20;
const MAX_VISIBILITY_SECONDS = 43_200;

// An SQS standard queue. Spec: docs/features/alert-queue-sqs.md.
// The client is built in the composition root, which owns region, endpoint and credentials.
export const createSqsAlertQueue = (client: SQSClient, queueUrl: string): AlertQueue => ({
	async send(ref: AlertRef) {
		// Only the ids travel. The alerts row holds the content.
		await client.send(
			new SendMessageCommand({
				QueueUrl: queueUrl,
				MessageBody: JSON.stringify({ tenantId: ref.tenantId, alertId: ref.alertId }),
			}),
		);
	},

	async receive(max, waitSeconds) {
		const { Messages = [] } = await client.send(
			new ReceiveMessageCommand({
				QueueUrl: queueUrl,
				MaxNumberOfMessages: Math.min(Math.max(1, max), MAX_RECEIVE),
				WaitTimeSeconds: Math.min(Math.max(0, waitSeconds), MAX_WAIT_SECONDS),
			}),
		);
		return Messages.flatMap((message): AlertQueueMessage[] =>
			message.MessageId && message.ReceiptHandle
				? [{ id: message.MessageId, receipt: message.ReceiptHandle, body: message.Body ?? "" }]
				: [],
		);
	},

	async delete(message) {
		await client.send(
			new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.receipt }),
		);
	},

	async retryAfter(message, delayMs) {
		await client.send(
			new ChangeMessageVisibilityCommand({
				QueueUrl: queueUrl,
				ReceiptHandle: message.receipt,
				VisibilityTimeout: Math.min(Math.ceil(delayMs / 1000), MAX_VISIBILITY_SECONDS),
			}),
		);
	},
});
