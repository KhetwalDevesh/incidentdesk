import { z } from "zod";

const DatabaseEnvSchema = z.object({
	DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "Must be a postgres:// connection string"),
});

const EnvSchema = DatabaseEnvSchema.extend({
	PORT: z.coerce.number().int().positive().default(3000),
	DEV_API_TOKENS: z.string().min(1),
});

export type Config = z.infer<typeof EnvSchema>;

// The only reader of process.env: enforce-rules check 1 pins this.
export const loadConfig = (): Config => EnvSchema.parse(process.env);

// For tools, such as the migration runner, that need only the database.
export const loadDatabaseConfig = () => DatabaseEnvSchema.parse(process.env);
