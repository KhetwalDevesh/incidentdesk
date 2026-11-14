import { Hono } from "hono";
import {
	LoginRequestSchema,
	SetupPasswordRequestSchema,
	SignupRequestSchema,
} from "../contract/auth";
import type { AuthService } from "../domain/auth/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toAccessTokenResponse } from "../mappers/auth";

// Public routes: they issue tokens, so app.ts mounts them before requireAuth.
export const authRoutes = (service: AuthService) =>
	new Hono<AppEnv>()
		.post("/signup", async (c) => {
			const parsed = SignupRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.signup(parsed.data);
			return respond(c, result, (token) => c.json(toAccessTokenResponse(token), 201));
		})
		.post("/login", async (c) => {
			const parsed = LoginRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.login(parsed.data);
			return respond(c, result, (token) => c.json(toAccessTokenResponse(token)));
		})
		.post("/setup-password", async (c) => {
			const parsed = SetupPasswordRequestSchema.safeParse(await c.req.json().catch(() => null));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.setupPassword(parsed.data);
			return respond(c, result, (token) => c.json(toAccessTokenResponse(token)));
		});
