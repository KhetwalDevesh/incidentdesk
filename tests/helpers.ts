import { createAesGcmSecretBox } from "../src/adapters/aesGcmSecretBox";
import { createArgon2PasswordHasher } from "../src/adapters/argon2PasswordHasher";
import {
	createHmacAlertSignatureVerifier,
	signAlertBody,
} from "../src/adapters/hmacAlertSignature";
import { InMemoryQueue } from "../src/adapters/inMemoryQueue";
import { createJwtTokenService } from "../src/adapters/jwtTokenService";
import {
	ALERT_SIGNATURE_HEADER,
	ALERT_TIMESTAMP_HEADER,
	CreatedAlertSourceSchema,
} from "../src/contract/alerts";
import { AccessTokenSchema } from "../src/contract/auth";
import type { AlertRef } from "../src/domain/alerts/types";
import {
	createWebhookPolicy,
	type DeliveryRef,
	type WebhookResult,
	type WebhookSender,
} from "../src/domain/notifications/types";
import type { Principal, TenantId } from "../src/domain/shared/identity";
import type { SummaryPrompt, SummaryWriter, WriterResult } from "../src/domain/summaries/types";
import { createApp } from "../src/http/app";
import { InMemoryAccountRepository } from "../src/repository/accounts/inMemoryAccountRepository";
import { InMemoryAlertRepository } from "../src/repository/alerts/inMemoryAlertRepository";
import { InMemoryAlertSourceRepository } from "../src/repository/alerts/inMemoryAlertSourceRepository";
import { InMemoryAuditStore } from "../src/repository/audit/inMemoryAuditStore";
import { InMemoryLoginThrottle } from "../src/repository/auth/inMemoryLoginThrottle";
import { InMemoryIncidentStatsReader } from "../src/repository/dashboard/inMemoryIncidentStatsReader";
import { InMemoryChangeFeed } from "../src/repository/events/inMemoryChangeFeed";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { InMemoryNotificationChannelRepository } from "../src/repository/notifications/inMemoryNotificationChannelRepository";
import { InMemoryNotificationDeliveryRepository } from "../src/repository/notifications/inMemoryNotificationDeliveryRepository";
import { InMemoryOnCallRepository } from "../src/repository/onCall/inMemoryOnCallRepository";
import { InMemoryPostmortemRepository } from "../src/repository/postmortems/inMemoryPostmortemRepository";
import { InMemorySummaryDraftRepository } from "../src/repository/summaries/inMemorySummaryDraftRepository";
import { createAlertIngestService } from "../src/services/alerts/alertIngestService";
import { createAlertProcessor } from "../src/services/alerts/alertProcessor";
import { createAlertService } from "../src/services/alerts/alertService";
import { createAlertSourceService } from "../src/services/alerts/alertSourceService";
import { createAuditService } from "../src/services/audit/auditService";
import { createAuthService } from "../src/services/auth/authService";
import {
	createDashboardBuilder,
	createDashboardService,
} from "../src/services/dashboard/dashboardService";
import { createEventHub } from "../src/services/events/eventHub";
import {
	createIncidentService,
	createIncidentViews,
} from "../src/services/incidents/incidentService";
import { createMemberService } from "../src/services/members/memberService";
import { createDeliveryDispatcher } from "../src/services/notifications/deliveryDispatcher";
import { createDeliveryProcessor } from "../src/services/notifications/deliveryProcessor";
import { createNotificationChannelService } from "../src/services/notifications/notificationChannelService";
import { createOnCallAssigner } from "../src/services/onCall/onCallAssigner";
import { createOnCallScheduleService } from "../src/services/onCall/onCallScheduleService";
import { createPostmortemProcessor } from "../src/services/postmortems/postmortemProcessor";
import { createPostmortemService } from "../src/services/postmortems/postmortemService";
import { createSummaryProcessor } from "../src/services/summaries/summaryProcessor";
import { createSummaryService } from "../src/services/summaries/summaryService";

export const TEST_JWT_SECRET = "test-secret-that-is-at-least-32-characters";
// 32 zero bytes. Tests only.
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");

// Fixed tokens for tests about incidents, so they need no signup. Real JWTs work alongside them.
const FIXED_TOKENS: Record<string, Principal> = {
	"acme-responder": { tenantId: "tenant-acme" as TenantId, userId: "user-1", role: "responder" },
	"acme-responder-2": { tenantId: "tenant-acme" as TenantId, userId: "user-2", role: "responder" },
	"globex-responder": {
		tenantId: "tenant-globex" as TenantId,
		userId: "user-3",
		role: "responder",
	},
	"acme-admin": { tenantId: "tenant-acme" as TenantId, userId: "user-4", role: "admin" },
};

// The allowlist tests run with: Slack, plus the dev receiver as local development adds it.
export const TEST_WEBHOOK_ORIGINS = ["https://hooks.slack.com", "http://127.0.0.1:4000"];

// Records each POST and answers from a script, so tests never call a real webhook.
export class FakeWebhookSender implements WebhookSender {
	readonly posts: { url: string; body: unknown }[] = [];
	// Answers in order; the last one repeats. Default: 200.
	answers: WebhookResult[] = [];

	async post(url: string, body: unknown): Promise<WebhookResult> {
		this.posts.push({ url, body });
		const answer = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
		return answer ?? { kind: "response", status: 200, retryAfter: null };
	}

	// The text of every message posted, in order.
	get texts(): string[] {
		return this.posts.map((post) => (post.body as { text: string }).text);
	}
}

export const FAKE_SUMMARY = {
	summary: "Checkout API latency is high in all regions.",
	suggestedSeverity: "sev1",
	rationale: "Customer-facing and widespread.",
};

export const FAKE_POSTMORTEM = {
	summary: "Checkout API latency was high in every region.",
	impact: "Customers checking out for 20 minutes.",
	timeline: [
		{ at: "2026-01-10T02:10:00Z", event: "Opened by an alert" },
		{ at: "2026-01-10T02:30:00Z", event: "Resolved" },
	],
	suspectedCause: "The data suggests a slow payment dependency.",
	wentWell: ["Acknowledged within two minutes"],
	wentWrong: ["No alert on p99 latency"],
	actionItems: ["Add a p99 latency alert"],
};

// Records each prompt and answers from a script, so tests never call a model. Default: a
// valid draft. Spec: docs/features/ai-summaries.md.
export class FakeSummaryWriter implements SummaryWriter {
	readonly prompts: SummaryPrompt[] = [];
	// Answers in order; the last one repeats.
	answers: WriterResult[] = [];

	async write(prompt: SummaryPrompt): Promise<WriterResult> {
		this.prompts.push(prompt);
		const answer = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
		return (
			answer ?? {
				kind: "ok",
				// A valid answer for whichever schema was asked for.
				content: JSON.stringify(
					prompt.schema.name === "incident_postmortem" ? FAKE_POSTMORTEM : FAKE_SUMMARY,
				),
				model: "test/fake-model",
				inputTokens: 1200,
				outputTokens: 80,
			}
		);
	}
}

// Cheap argon2 costs keep the suite fast. Production uses the library defaults.
export const testHasher = () => createArgon2PasswordHasher({ memoryCost: 1024, timeCost: 1 });

export const buildTestApp = (
	options: {
		tokenNowMs?: () => number;
		notificationChannels?: InMemoryNotificationChannelRepository;
		channelNow?: () => Date;
		alertNow?: () => Date;
		dashboardDelayMs?: number;
		// The throttle's clock. Spec: docs/features/login-rate-limiting.md.
		authNow?: () => Date;
		trustedProxyHops?: number;
		// Spec: docs/features/ai-summaries.md.
		aiDailyCap?: number;
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
		dashboardDelayMs?: number;
		// The throttle's clock. Spec: docs/features/login-rate-limiting.md.
		authNow?: () => Date;
		trustedProxyHops?: number;
		// Spec: docs/features/ai-summaries.md.
		aiDailyCap?: number;
	} = {},
) => {
	// One audit store for every repository, as Postgres has one audit_events table.
	const audit = new InMemoryAuditStore();
	// One feed for every repository, as Postgres has one NOTIFY channel.
	const feed = new InMemoryChangeFeed();
	const accounts = new InMemoryAccountRepository(audit, feed);
	const throttle = new InMemoryLoginThrottle();
	const authService = createAuthService({
		credentials: accounts,
		accounts,
		hasher: testHasher(),
		tokens: createJwtTokenService(TEST_JWT_SECRET, 3600, options.tokenNowMs),
		throttle,
		now: options.authNow,
		audit,
	});
	const secrets = createAesGcmSecretBox(TEST_ENCRYPTION_KEY);
	const channels = options.notificationChannels ?? new InMemoryNotificationChannelRepository(audit);
	const deliveries = new InMemoryNotificationDeliveryRepository(channels);
	const notificationQueue = new InMemoryQueue<DeliveryRef>({ now: options.alertNow });
	const dispatcher = createDeliveryDispatcher({
		deliveries,
		queue: notificationQueue,
		now: options.alertNow,
	});
	const policy = createWebhookPolicy(TEST_WEBHOOK_ORIGINS);
	const drafts = new InMemorySummaryDraftRepository(feed);
	const postmortems = new InMemoryPostmortemRepository(audit, feed);
	const incidents = new InMemoryIncidentRepository(audit, deliveries, accounts, feed, drafts);
	const views = createIncidentViews(accounts);
	const dashboardDeps = {
		stats: new InMemoryIncidentStatsReader(incidents),
		members: accounts,
		now: options.alertNow,
	};
	const schedules = new InMemoryOnCallRepository(accounts);
	const onCall = createOnCallAssigner(schedules);
	const alertSources = new InMemoryAlertSourceRepository(audit, schedules);
	const alerts = new InMemoryAlertRepository(incidents);
	const queue = new InMemoryQueue<AlertRef>({ now: options.alertNow });
	const realtimeErrors: { subject: string; error: unknown }[] = [];
	const eventHub = createEventHub({
		feed,
		incidents,
		views,
		schedules,
		drafts,
		postmortemDrafts: incidents.postmortemDrafts,
		postmortems,
		dashboard: (tenantId) => createDashboardBuilder(dashboardDeps)(tenantId, null),
		now: options.alertNow,
		// Short, so stream tests need not wait the production second.
		dashboardDelayMs: options.dashboardDelayMs ?? 10,
		onError: (subject, error) => realtimeErrors.push({ subject, error }),
	});
	const app = createApp({
		authenticate: async (token) => FIXED_TOKENS[token] ?? authService.authenticate(token),
		authService,
		incidentService: createIncidentService(incidents, {
			members: accounts,
			dispatcher,
			onCall,
			now: options.alertNow,
			aiDrafts: { dailyCap: options.aiDailyCap ?? 100 },
		}),
		memberService: createMemberService(accounts),
		notificationChannelService: createNotificationChannelService({
			channels,
			deliveries,
			secrets,
			policy,
			now: options.channelNow,
		}),
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
		onCallScheduleService: createOnCallScheduleService(schedules, options.alertNow),
		dashboardService: createDashboardService(dashboardDeps),
		eventHub,
		summaryService: createSummaryService({
			incidents,
			drafts,
			views,
			dailyCap: options.aiDailyCap ?? 100,
			now: options.alertNow,
		}),
		postmortemService: createPostmortemService({
			incidents,
			drafts: incidents.postmortemDrafts,
			postmortems,
			dailyCap: options.aiDailyCap ?? 100,
			now: options.alertNow,
		}),
		trustedProxyHops: options.trustedProxyHops ?? 0,
	});
	const processor = createAlertProcessor({
		queue,
		alerts,
		outbox: alerts,
		now: options.alertNow,
		sources: alertSources,
		dispatcher,
		onCall,
		aiDrafts: { dailyCap: options.aiDailyCap ?? 100 },
	});
	// A fake model: tests set its answers. No test ever calls a real provider.
	const writer = new FakeSummaryWriter();
	const summaryProcessor = createSummaryProcessor({
		drafts,
		incidents,
		alerts,
		writer,
		now: options.alertNow,
	});
	const postmortemProcessor = createPostmortemProcessor({
		drafts: incidents.postmortemDrafts,
		incidents,
		alerts,
		audit,
		writer,
		now: options.alertNow,
	});
	const sender = new FakeWebhookSender();
	const deliveryErrors: { subject: string; error: unknown }[] = [];
	const deliveryProcessor = createDeliveryProcessor({
		queue: notificationQueue,
		deliveries,
		outbox: deliveries,
		channels,
		secrets,
		sender,
		policy,
		now: options.alertNow,
		onError: (subject, error) => deliveryErrors.push({ subject, error }),
	});
	return {
		app,
		processor,
		incidents,
		feed,
		eventHub,
		realtimeErrors,
		throttle,
		drafts,
		writer,
		summaryProcessor,
		postmortems,
		postmortemProcessor,
		schedules,
		alerts,
		queue,
		audit,
		accounts,
		channels,
		deliveries,
		notificationQueue,
		deliveryProcessor,
		sender,
		deliveryErrors,
	};
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
