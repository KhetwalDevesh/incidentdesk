import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError } from "zod";
import { ERROR_CODES, type Problem } from "../contract/common";
import type { AppError, Result } from "../domain/shared/result";
import type { AppEnv } from "./types";

const titleFor = (code: AppError["code"]) =>
	code
		.toLowerCase()
		.replaceAll("_", " ")
		.replace(/^./, (first) => first.toUpperCase());

export const problemResponse = (c: Context<AppEnv>, error: AppError) => {
	const status = ERROR_CODES[error.code];
	const body: Problem = {
		type: "about:blank",
		title: titleFor(error.code),
		status,
		code: error.code,
		detail: error.detail,
		requestId: c.get("requestId"),
		...(error.errors ? { errors: error.errors } : {}),
	};
	return c.body(JSON.stringify(body), status as ContentfulStatusCode, {
		"Content-Type": "application/problem+json",
	});
};

export const validationError = (error: ZodError): AppError => ({
	code: "VALIDATION_FAILED",
	detail: "The request is invalid",
	errors: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
});

export const respond = <T>(
	c: Context<AppEnv>,
	result: Result<T>,
	onSuccess: (value: T) => Response,
) => (result.ok ? onSuccess(result.value) : problemResponse(c, result.error));
