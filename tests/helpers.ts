import { createAesGcmSecretBox } from "../src/adapters/aesGcmSecretBox";
import { createArgon2PasswordHasher } from "../src/adapters/argon2PasswordHasher";
import {
	createHmacAlertSignatureVerifier,
	signAlertBody,
} from "../src/adapters/hmacAlertSignature";
import { InMemoryAlertQueue } from "../src/adapters/inMemoryAlertQueue";
import { createJwtTokenService } from "../src/adapters/jwtTokenService";
import {
	ALERT_SIGNATURE_HEADER,
	ALERT_TIMESTAMP_HEADER,
	CreatedAlertSourceSchema,
} from "../src/contract/alerts";
import { AccessTokenSchema } from "../src/contract/auth";
import type { Principal, TenantId } from "../src/domain/shared/identity";
import { createApp } from "../src/http/app";
import { InMemoryAccountRepository } from "../src/repository/accounts/inMemoryAccountRepository";
import { InMemoryAlertRepository } from "../src/repository/alerts/inMemoryAlertRepository";
import { InMemoryAlertSourceRepository } from "../src/repository/alerts/inMemoryAlertSourceRepository";
import { InMemoryAuditStore } from "../src/repository/audit/inMemoryAuditStore";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { InMemoryNotificationChannelRepository } from "../src/repository/notifications/inMemoryNotificationChannelRepository";
import { createAlertIngestService } from "../src/services/alerts/alertIngestService";
import { createAlertProcessor } from "../src/services/alerts/alertProcessor";
import { createAlertService } from "../src/services/alerts/alertService";
import { createAlertSourceService } from "../src/services/alerts/alertSourceService";
import { createAuditService } from "../src/services/audit/auditService";
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
		alertNow?: () => Date;
	} = {},
) => buildTestSystem(options).app;

// The app plus the alert worker, sharing in-memory stores, for tests that follow an alert
// from the webhook to an incident.
export const buildTestSystem = (
	options: {
		tokenNowMs?: () => number;
		notificationChannels?: InMemoryNotificationChannelRepository;
		channelNow?: () => Date;
		alertNow?: () => Date;
	} = {},
) => {
	// One audit store for every repository, as Postgres has one audit_events table.
	const audit = new InMemoryAuditStore();
	const accounts = new InMemoryAccountRepository(audit);
	const authService = createAuthService({
		credentials: accounts,
		accounts,
		hasher: testHasher(),
		tokens: createJwtTokenService(TEST_JWT_SECRET, 3600, options.tokenNowMs),
		audit,
	});
	const secrets = createAesGcmSecretBox(TEST_ENCRYPTION_KEY);
	const incidents = new InMemoryIncidentRepository(audit);
	const alertSources = new InMemoryAlertSourceRepository(audit);
	const alerts = new InMemoryAlertRepository(incidents);
	const queue = new InMemoryAlertQueue({ now: options.alertNow });
	const app = createApp({
		authenticate: async (token) => FIXED_TOKENS[token] ?? authService.authenticate(token),
		authService,
		incidentService: createIncidentService(incidents),
		memberService: createMemberService(accounts),
		notificationChannelService: createNotificationChannelService(
			options.notificationChannels ?? new InMemoryNotificationChannelRepository(audit),
			secrets,
			options.channelNow,
		),
		alertSourceService: createAlertSourceService(alertSources, secrets),
		alertService: createAlertService(alerts),
		alertIngestService: createAlertIngestService({
			sources: alertSources,
			alerts,
			queue,
			secrets,
			signatures: createHmacAlertSignatureVerifier(),
			now: options.alertNow,
		}),
		auditService: createAuditService(audit, incidents),
	});
	const processor = createAlertProcessor({
		queue,
		alerts,
		outbox: alerts,
		now: options.alertNow,
	});
	return { app, processor, alerts, queue, audit };
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

// A webhook request signed as a monitoring tool would sign it.
export const signedAlert = (
	secret: string,
	body: unknown,
	timestamp = String(Math.floor(Date.now() / 1000)),
): RequestInit => {
	const raw = typeof body === "string" ? body : JSON.stringify(body);
	return {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			[ALERT_TIMESTAMP_HEADER]: timestamp,
			[ALERT_SIGNATURE_HEADER]: signAlertBody(secret, timestamp, raw),
		},
		body: raw,
	};
};

// Adds an alert source as the given admin, and returns its id and secret.
export const addAlertSource = async (app: TestApp, adminToken: string, name = "prometheus") => {
	const res = await app.request("/v1/alert-sources", authed(adminToken, { name }));
	const created = CreatedAlertSourceSchema.parse(await res.json());
	return { sourceId: created.id, secret: created.secret };
};

export const signup = async (app: TestApp, email: string, tenantName = "Acme") => {
	const res = await app.request(
		"/v1/auth/signup",
		post({ tenantName, email, password: "correct horse battery" }),
	);
	return AccessTokenSchema.parse(await res.json()).accessToken;
};
