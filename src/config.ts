import { z } from "zod";

const DatabaseEnvSchema = z.object({
	DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "Must be a postgres:// connection string"),
});

const EnvSchema = DatabaseEnvSchema.extend({
	PORT: z.coerce.number().int().positive().default(3000),
	// Signs access tokens. Generate with: openssl rand -base64 48
	JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
	ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
	// Encrypts notification webhook URLs at rest. 32 bytes, base64. Generate with: openssl rand -base64 32
	NOTIFICATION_ENCRYPTION_KEY: z
		.string()
		.refine(
			(value) => Buffer.from(value, "base64").length === 32,
			"NOTIFICATION_ENCRYPTION_KEY must be 32 bytes, base64-encoded",
		),
	// The alert queue. Credentials come from the AWS SDK's default provider chain, never from here.
	AWS_REGION: z.string().min(1),
	ALERT_QUEUE_URL: z.url(),
	// The notification queue: one message per Slack delivery. Spec: docs/features/slack-delivery.md.
	NOTIFICATION_QUEUE_URL: z.url(),
	// The only origins the server posts webhooks to, comma-separated. Checked when a channel is
	// created and before every send, so the server cannot be pointed at an internal address.
	NOTIFICATION_WEBHOOK_ORIGINS: z
		.string()
		.default("https://hooks.slack.com")
		.transform((value, ctx) => {
			const origins = value
				.split(",")
				.map((origin) => origin.trim())
				.filter(Boolean);
			for (const origin of origins) {
				// An origin, exactly: scheme, host and port, with no path or trailing slash.
				if (!URL.canParse(origin) || new URL(origin).origin !== origin) {
					ctx.addIssue({ code: "custom", message: `Not an origin: ${origin}` });
					return z.NEVER;
				}
			}
			return origins;
		}),
	// Load balancers or proxies in front of the API. Their X-Forwarded-For entries name the
	// client; anything further left is the client's own claim and is ignored.
	// Spec: docs/features/login-rate-limiting.md.
	TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
	// AI summary drafts. Spec: docs/features/ai-summaries.md. An OpenAI-compatible endpoint:
	// OpenRouter by default. Without AI_API_KEY no model is called and drafts are skipped.
	AI_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
	AI_API_KEY: z.string().min(1).optional(),
	// openrouter/free in development, qwen/qwen3-30b-a3b-instruct-2507 in production.
	AI_MODEL: z.string().min(1).max(200).optional(),
	// Route only to providers that keep no prompts. Set false for free models in development.
	AI_DENY_DATA_COLLECTION: z
		.enum(["true", "false"])
		.default("true")
		.transform((value) => value === "true"),
	AI_DAILY_DRAFT_CAP: z.coerce.number().int().min(0).max(100_000).default(100),
	// Set only for a local emulator such as LocalStack.
	AWS_ENDPOINT_URL: z.url().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

// A key with no model would send every draft to a model nobody chose.
const checkAi = (config: Config): Config => {
	if (config.AI_API_KEY && !config.AI_MODEL) {
		throw new Error("AI_MODEL is required when AI_API_KEY is set");
	}
	return config;
};

// The only reader of process.env: enforce-rules check 1 pins this.
export const loadConfig = (): Config => checkAi(EnvSchema.parse(process.env));

// For tools, such as the migration runner, that need only the database.
export const loadDatabaseConfig = () => DatabaseEnvSchema.parse(process.env);
