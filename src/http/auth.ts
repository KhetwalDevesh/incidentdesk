import type { MiddlewareHandler } from "hono";
import type { Principal } from "../domain/shared/identity";
import { problemResponse } from "./problem";
import type { AppEnv } from "./types";

export type Authenticator = (token: string) => Promise<Principal | null>;

export const requireAuth =
	(authenticate: Authenticator): MiddlewareHandler<AppEnv> =>
	async (c, next) => {
		const header = c.req.header("Authorization");
		const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
		const principal = token ? await authenticate(token) : null;
		if (!principal) {
			return problemResponse(c, {
				code: "UNAUTHENTICATED",
				detail: "A valid bearer token is required",
			});
		}
		c.set("principal", principal);
		await next();
	};
