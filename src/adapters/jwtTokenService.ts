import { sign, verify } from "hono/jwt";
import type { TokenService } from "../domain/auth/types";
import type { TenantId } from "../domain/shared/identity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Pinned, so a token whose header names another algorithm, or none, is refused.
const ALGORITHM = "HS256";

// Tokens carry identity only. Role is loaded from the database on every request.
export const createJwtTokenService = (
	secret: string,
	ttlSeconds: number,
	nowMs: () => number = Date.now,
): TokenService => ({
	async issue({ tenantId, userId }) {
		const iat = Math.floor(nowMs() / 1000);
		const accessToken = await sign(
			{ sub: userId, tid: tenantId, iat, exp: iat + ttlSeconds },
			secret,
			ALGORITHM,
		);
		return { accessToken, expiresIn: ttlSeconds };
	},

	async verify(token) {
		try {
			const { sub, tid } = await verify(token, secret, ALGORITHM);
			if (typeof sub !== "string" || typeof tid !== "string") return null;
			if (!UUID.test(sub) || !UUID.test(tid)) return null;
			return { tenantId: tid as TenantId, userId: sub };
		} catch {
			return null;
		}
	},
});
