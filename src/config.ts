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
});

export type Config = z.infer<typeof EnvSchema>;

// The only reader of process.env: enforce-rules check 1 pins this.
export const loadConfig = (): Config => EnvSchema.parse(process.env);

// For tools, such as the migration runner, that need only the database.
export const loadDatabaseConfig = () => DatabaseEnvSchema.parse(process.env);
