import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export const ERROR_CODES = {
	UNAUTHENTICATED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	VALIDATION_FAILED: 422,
	INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

const errorCodes = Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]];

export const ProblemSchema = z
	.strictObject({
		type: z.literal("about:blank"),
		title: z.string(),
		status: z.number().int(),
		code: z.enum(errorCodes),
		detail: z.string(),
		requestId: z.string(),
		errors: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
	})
	.openapi("Problem", { description: "RFC 9457 problem details" });

export type Problem = z.infer<typeof ProblemSchema>;

export const PageQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;
