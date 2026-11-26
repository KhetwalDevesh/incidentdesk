import { defineConfig } from "vitest/config";

// `pnpm test:sqs`: tests against real AWS services. Not part of `pnpm check` or CI, which need
// no AWS credentials. Reads .env for AWS_PROFILE, AWS_REGION and TEST_ALERT_QUEUE_URL.
try {
	process.loadEnvFile(".env");
} catch {
	// No .env: the test explains which variables it needs.
}

export default defineConfig({
	test: {
		include: ["tests/**/*.integration.test.ts"],
		testTimeout: 60_000,
		// One queue, so the files must not race each other.
		fileParallelism: false,
	},
});
