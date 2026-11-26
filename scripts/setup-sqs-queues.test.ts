import { describe, expect, it } from "vitest";
import { MAX_RECEIVE_COUNT, parseArgs, queueAttributes } from "./setup-sqs-queues";

describe("sqs:setup arguments", () => {
	it("reads a queue name and region", () => {
		expect(parseArgs(["--name", "incidentdesk-alerts-dev", "--region", "ap-south-1"])).toEqual({
			name: "incidentdesk-alerts-dev",
			region: "ap-south-1",
		});
	});

	it("refuses a missing or unsafe name, and a missing or malformed region", () => {
		expect(() => parseArgs(["--region", "ap-south-1"])).toThrow("--name");
		expect(() => parseArgs(["--name", "a b", "--region", "ap-south-1"])).toThrow("--name");
		expect(() => parseArgs(["--name", "x".repeat(77), "--region", "ap-south-1"])).toThrow("--name");
		expect(() => parseArgs(["--name", "alerts"])).toThrow("--region");
		expect(() => parseArgs(["--name", "alerts", "--region", "mars"])).toThrow("--region");
	});
});

describe("sqs:setup queue settings", () => {
	it("matches the worker's 60 s visibility and redrives to the DLQ after 10 receives", () => {
		const attributes = queueAttributes("arn:aws:sqs:ap-south-1:123456789012:alerts-dlq");

		expect(attributes.VisibilityTimeout).toBe("60");
		expect(JSON.parse(attributes.RedrivePolicy)).toEqual({
			deadLetterTargetArn: "arn:aws:sqs:ap-south-1:123456789012:alerts-dlq",
			maxReceiveCount: String(MAX_RECEIVE_COUNT),
		});
		expect(MAX_RECEIVE_COUNT).toBe(10);
	});
});
