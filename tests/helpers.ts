import { createAesGcmSecretBox } from "../src/adapters/aesGcmSecretBox";
import { createArgon2PasswordHasher } from "../src/adapters/argon2PasswordHasher";
import { createJwtTokenService } from "../src/adapters/jwtTokenService";
import { AccessTokenSchema } from "../src/contract/auth";
import type { Principal, TenantId } from "../src/domain/shared/identity";
import { createApp } from "../src/http/app";
import { InMemoryAccountRepository } from "../src/repository/accounts/inMemoryAccountRepository";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { InMemoryNotificationChannelRepository } from "../src/repository/notifications/inMemoryNotificationChannelRepository";
import { createAuthService } from "../src/services/auth/authService";
import { createIncidentService } from "../src/services/incidents/incidentService";
import { createMemberService } from "../src/services/members/memberService";
import { createNotificationChannelService } from "../src/services/notifications/notificationChannelService";

export const TEST_JWT_SECRET = "test-secret-that-is-at-least-32-characters";
// 32 zero bytes. Tests only.
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");

// Fixed tokens for tests about incidents, so they need no signup. Real JWTs work alongside them.
const FIXED_TOKENS: Record<string, Principal> = {
	"acme-responder": { tenantId: "tenant-acme" as TenantId, userId: "user-1", role: "responder" },
	"acme-viewer": { tenantId: "tenant-acme" as TenantId, userId: "user-2", role: "viewer" },
	"globex-responder": {
		tenantId: "tenant-globex" as TenantId,
		userId: "user-3",
		role: "responder",
	},
	"acme-admin": { tenantId: "tenant-acme" as TenantId, userId: "user-4", role: "admin" },
};

// Cheap argon2 costs keep the suite fast. Production uses the library defaults.
export const testHasher = () => createArgon2PasswordHasher({ memoryCost: 1024, timeCost: 1 });

export const buildTestApp = (
	options: {
		tokenNowMs?: () => number;
		notificationChannels?: InMemoryNotificationChannelRepository;
		channelNow?: () => Date;
	} = {},
) => {
	const accounts = new InMemoryAccountRepository();
	const authService = createAuthService({
		credentials: accounts,
		accounts,
		hasher: testHasher(),
		tokens: createJwtTokenService(TEST_JWT_SECRET, 3600, options.tokenNowMs),
	});
	return createApp({
		authenticate: async (token) => FIXED_TOKENS[token] ?? authService.authenticate(token),
		authService,
		incidentService: createIncidentService(new InMemoryIncidentRepository()),
		memberService: createMemberService(accounts),
		notificationChannelService: createNotificationChannelService(
			options.notificationChannels ?? new InMemoryNotificationChannelRepository(),
			createAesGcmSecretBox(TEST_ENCRYPTION_KEY),
			options.channelNow,
		),
	});
};

export const authed = (token: string, body?: unknown): RequestInit => ({
	method: body === undefined ? "GET" : "POST",
	headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const post = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

type TestApp = ReturnType<typeof buildTestApp>;

export const signup = async (app: TestApp, email: string, tenantName = "Acme") => {
	const res = await app.request(
		"/v1/auth/signup",
		post({ tenantName, email, password: "correct horse battery" }),
	);
	return AccessTokenSchema.parse(await res.json()).accessToken;
};
