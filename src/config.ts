import { z } from "zod";

const EnvSchema = z.object({
	PORT: z.coerce.number().int().positive().default(3000),
	DEV_API_TOKENS: z.string().min(1),
});

export type Config = z.infer<typeof EnvSchema>;

// The only reader of process.env: enforce-rules check 1 pins this.
export const loadConfig = (): Config => EnvSchema.parse(process.env);
