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
	// Set only for a local emulator such as LocalStack.
	AWS_ENDPOINT_URL: z.url().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

// The only reader of process.env: enforce-rules check 1 pins this.
export const loadConfig = (): Config => EnvSchema.parse(process.env);

// For tools, such as the migration runner, that need only the database.
export const loadDatabaseConfig = () => DatabaseEnvSchema.parse(process.env);
