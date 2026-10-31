import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { type Principal, ROLES, type Role, type TenantId } from "../domain/shared/identity";
import { problemResponse } from "./problem";
import type { AppEnv } from "./types";

export type Authenticator = (token: string) => Principal | null;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

// Development stand-in for real auth. Tokens are held hashed so a heap dump does not expose them.
export const createDevTokenAuthenticator = (config: string): Authenticator => {
	const principals = new Map<string, Principal>();
	for (const entry of config.split(",")) {
		const [token, tenantId, userId, role] = entry.trim().split(":");
		if (!token || !tenantId || !userId || !role || !isRole(role)) {
			throw new Error("DEV_API_TOKENS entries must be token:tenantId:userId:role");
		}
		principals.set(sha256(token), { tenantId: tenantId as TenantId, userId, role });
	}
	return (token) => principals.get(sha256(token)) ?? null;
};

export const requireAuth =
	(authenticate: Authenticator): MiddlewareHandler<AppEnv> =>
	async (c, next) => {
		const header = c.req.header("Authorization");
		const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
		const principal = token ? authenticate(token) : null;
		if (!principal) {
			return problemResponse(c, {
				code: "UNAUTHENTICATED",
				detail: "A valid bearer token is required",
			});
		}
		c.set("principal", principal);
		await next();
	};
