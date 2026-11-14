import { z } from "zod";
import "./common";

// Trimmed and lowercased before the format check, so " A@B.com " and "a@b.com" are one account.
export const EmailSchema = z.string().trim().toLowerCase().max(254).email();

// The upper bound stops a huge password from turning hashing into a denial of service.
const NewPasswordSchema = z.string().min(12).max(128);

export const SignupRequestSchema = z
	.strictObject({
		tenantName: z.string().trim().min(1).max(100),
		email: EmailSchema,
		password: NewPasswordSchema,
	})
	.openapi("SignupRequest");

export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const LoginRequestSchema = z
	.strictObject({
		email: EmailSchema,
		password: z.string().min(1).max(128),
	})
	.openapi("LoginRequest");

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const SetupPasswordRequestSchema = z
	.strictObject({
		token: z.string().min(1).max(200),
		password: NewPasswordSchema,
	})
	.openapi("SetupPasswordRequest");

export type SetupPasswordRequest = z.infer<typeof SetupPasswordRequestSchema>;

export const AccessTokenSchema = z
	.strictObject({
		accessToken: z.string(),
		tokenType: z.literal("Bearer"),
		expiresIn: z.number().int(),
	})
	.openapi("AccessToken");

export type AccessTokenResponse = z.infer<typeof AccessTokenSchema>;
