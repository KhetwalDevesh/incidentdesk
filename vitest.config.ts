import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
		// Real AWS services: run with `pnpm test:sqs`. See vitest.integration.config.ts.
		exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
	},
});
