import type { ErrorCode } from "../../contract/common";

export type AppError = {
	code: ErrorCode;
	detail: string;
	errors?: { path: string; message: string }[];
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = (code: ErrorCode, detail: string): Result<never> => ({
	ok: false,
	error: { code, detail },
});
