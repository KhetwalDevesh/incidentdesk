// Creates a developer's alert queue and its dead-letter queue in AWS SQS, or confirms they
// exist with the expected settings. Spec: docs/features/alert-queue-sqs.md.
//
//   pnpm sqs:setup --name incidentdesk-alerts-<you> --region ap-south-1
//   pnpm sqs:setup --name incidentdesk-alerts-<you>-test --region ap-south-1   # for pnpm test:sqs
//
// Credentials come from the AWS SDK's default chain: set AWS_PROFILE in .env to a profile made
// with `aws configure --profile <name>`. Every developer uses their own queues, so workers never
// take each other's messages.

import { fileURLToPath } from "node:url";
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

// Matches the worker: a received message stays hidden for 60 s unless the worker changes it.
export const VISIBILITY_TIMEOUT_SECONDS = 60;
// A message received this often without being deleted moves to the dead-letter queue.
export const MAX_RECEIVE_COUNT = 10;
const FOUR_DAYS_SECONDS = 4 * 24 * 60 * 60;
const FOURTEEN_DAYS_SECONDS = 14 * 24 * 60 * 60;

// SQS allows 80 characters. "-dlq" takes 4.
const QUEUE_NAME = /^[A-Za-z0-9_-]{1,76}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export type SetupOptions = { name: string; region: string };

export const parseArgs = (argv: string[]): SetupOptions => {
	const value = (flag: string) => {
		const index = argv.indexOf(flag);
		return index === -1 ? undefined : argv[index + 1];
	};
	const name = value("--name");
	const region = value("--region");
	if (!name || !QUEUE_NAME.test(name)) {
		throw new Error("--name is required: letters, digits, - and _, at most 76 characters");
	}
	if (!region || !REGION.test(region)) {
		throw new Error("--region is required, for example --region ap-south-1");
	}
	return { name, region };
};

export const dlqAttributes = () => ({
	MessageRetentionPeriod: String(FOURTEEN_DAYS_SECONDS),
	SqsManagedSseEnabled: "true",
});

export const queueAttributes = (dlqArn: string) => ({
	VisibilityTimeout: String(VISIBILITY_TIMEOUT_SECONDS),
	ReceiveMessageWaitTimeSeconds: "20",
	MessageRetentionPeriod: String(FOUR_DAYS_SECONDS),
	SqsManagedSseEnabled: "true",
	RedrivePolicy: JSON.stringify({
		deadLetterTargetArn: dlqArn,
		maxReceiveCount: String(MAX_RECEIVE_COUNT),
	}),
});

const setup = async ({ name, region }: SetupOptions) => {
	const client = new SQSClient({ region });
	// CreateQueue is idempotent while the attributes match, and fails if they differ.
	const dlq = await client.send(
		new CreateQueueCommand({ QueueName: `${name}-dlq`, Attributes: dlqAttributes() }),
	);
	const { Attributes } = await client.send(
		new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }),
	);
	const dlqArn = Attributes?.QueueArn;
	if (!dlqArn) throw new Error("The dead-letter queue has no ARN");
	const queue = await client.send(
		new CreateQueueCommand({ QueueName: name, Attributes: queueAttributes(dlqArn) }),
	);

	console.log(`Queue:             ${queue.QueueUrl}`);
	console.log(`Dead-letter queue: ${dlq.QueueUrl}`);
	console.log(`\nAdd to .env:\nAWS_REGION=${region}\nALERT_QUEUE_URL=${queue.QueueUrl}`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		await setup(parseArgs(process.argv.slice(2)));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
