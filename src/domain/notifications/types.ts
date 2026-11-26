import type { PageQuery } from "../../contract/common";
import type { IncidentId, IncidentSeverity } from "../../contract/incidents";
import type {
	CreateNotificationChannelRequest,
	DELIVERY_FAILURE_REASONS,
	DELIVERY_STATES,
	NOTIFICATION_CHANNEL_KINDS,
	NOTIFICATION_EVENTS,
} from "../../contract/notificationChannels";
import type { AuditEntry } from "../audit/types";
import type { Principal, TenantId } from "../shared/identity";
import type { MessageQueue } from "../shared/queue";
import type { RequestContext } from "../shared/request";
import type { Result } from "../shared/result";

export type NotificationChannel = {
	id: string;
	tenantId: TenantId;
	kind: (typeof NOTIFICATION_CHANNEL_KINDS)[number];
	name: string;
	// The webhook URL, sealed by a SecretBox. The plaintext URL is never stored.
	targetCiphertext: Uint8Array;
	targetHint: string;
	minSeverity: IncidentSeverity;
	enabled: boolean;
	createdAt: Date;
};

export type NotificationChannelPage = { items: NotificationChannel[]; total: number };

// Every method takes tenantId first, like every repository.
export interface NotificationChannelRepository {
	// Returns null when the tenant already has a channel with this name.
	create(
		tenantId: TenantId,
		channel: Omit<NotificationChannel, "tenantId">,
		// Written only when the channel is created.
		audit: AuditEntry,
	): Promise<NotificationChannel | null>;
	list(tenantId: TenantId, page: PageQuery): Promise<NotificationChannelPage>;
	findById(tenantId: TenantId, id: string): Promise<NotificationChannel | null>;
}

// Encrypts secrets at rest. `context` is bound to the ciphertext, so a value
// moved to another row fails to open.
export interface SecretBox {
	seal(plaintext: string, context: string): Uint8Array;
	// Throws when the ciphertext was tampered with, or the context differs.
	open(ciphertext: Uint8Array, context: string): string;
}

// The context a channel's webhook URL is sealed under.
export const channelSecretContext = (tenantId: TenantId, channelId: string) =>
	`notification_channel:${tenantId}:${channelId}`;

export interface NotificationChannelService {
	create(
		principal: Principal,
		input: CreateNotificationChannelRequest,
		context?: RequestContext,
	): Promise<Result<NotificationChannel>>;
	list(principal: Principal, page: PageQuery): Promise<Result<NotificationChannelPage>>;
	listDeliveries(
		principal: Principal,
		channelId: string,
		page: PageQuery,
	): Promise<Result<NotificationDeliveryPage>>;
}

// ---- Delivery. Spec: docs/features/slack-delivery.md

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type DeliveryFailureReason = (typeof DELIVERY_FAILURE_REASONS)[number];

// Who changed the incident. A member's email is kept only while the delivery is pending, and
// is null when the member no longer existed when the change was recorded.
export type DeliveryActor =
	| { type: "user"; email: string | null }
	| { type: "alert_source"; name: string };

// The message snapshot, taken in the transaction that changed the incident. Never the URL.
export type DeliveryPayload = {
	title: string;
	severity: IncidentSeverity;
	actor: DeliveryActor;
	alertCount: number;
	openedAt: string;
	occurredAt: string;
};

export type NotificationDelivery = {
	id: string;
	tenantId: TenantId;
	channelId: string;
	incidentId: IncidentId;
	event: NotificationEvent;
	payload: DeliveryPayload;
	state: DeliveryState;
	// Counted attempts. A rate-limited attempt is not counted.
	attempts: number;
	nextAttemptAt: Date;
	sentAt: Date | null;
	failureReason: DeliveryFailureReason | null;
	lastStatus: number | null;
	// Internal error text. Never leaves the API, and never holds the webhook URL.
	lastError: string | null;
	createdAt: Date;
	deliveredAt: Date | null;
};

export type NotificationDeliveryPage = { items: NotificationDelivery[]; total: number };

// What an incident change asks to post. Repositories turn it into one pending delivery per
// enabled channel whose minSeverity the incident meets, in the change's own transaction.
export type DeliveryNotice = {
	incidentId: IncidentId;
	event: NotificationEvent;
	severity: IncidentSeverity;
	payload: DeliveryPayload;
	createdAt: Date;
};

// Does a channel with this minimum severity get an incident of this severity? sev1 is the
// most severe, so a sev4 channel gets everything.
export const meetsMinSeverity = (severity: IncidentSeverity, minSeverity: IncidentSeverity) =>
	severity <= minSeverity;

// What a queue message carries. The delivery row stays the source of truth.
export type DeliveryRef = { tenantId: TenantId; deliveryId: string };

// The message body for a ref: the two ids and nothing else.
export const deliveryQueueBody = ({ tenantId, deliveryId }: DeliveryRef) => ({
	tenantId,
	deliveryId,
});

export type NotificationQueue = MessageQueue<DeliveryRef>;

// What startAttempt found: the delivery it started, a delivery another attempt still holds
// until `until`, or nothing to do (unknown, delivered or failed).
export type AttemptStart =
	| { status: "started"; delivery: NotificationDelivery }
	| { status: "leased"; until: Date }
	| null;

// Tenant-scoped. Every method takes tenantId first, like every repository.
export interface NotificationDeliveryRepository {
	// Pending deliveries for one incident event whose queue message was never sent, oldest
	// first. Bounded: one per channel.
	listUnsent(
		tenantId: TenantId,
		incidentId: IncidentId,
		event: NotificationEvent,
	): Promise<DeliveryRef[]>;
	markSent(tenantId: TenantId, deliveryId: string, sentAt: Date): Promise<void>;
	// Starts an attempt on a pending delivery that no other attempt holds: increments attempts
	// and holds it until `leaseUntil`, so a duplicate message cannot post it twice at once.
	startAttempt(
		tenantId: TenantId,
		deliveryId: string,
		now: Date,
		leaseUntil: Date,
	): Promise<AttemptStart>;
	// Marks a pending delivery delivered and removes the actor's email.
	deliver(tenantId: TenantId, deliveryId: string, status: number, at: Date): Promise<void>;
	// Schedules another attempt. `counted: false` gives back the attempt startAttempt took.
	retry(
		tenantId: TenantId,
		deliveryId: string,
		outcome: { retryAt: Date; counted: boolean; status: number | null; error: string },
	): Promise<void>;
	// Marks a pending delivery failed for good and removes the actor's email.
	fail(
		tenantId: TenantId,
		deliveryId: string,
		outcome: { reason: DeliveryFailureReason; status: number | null; error: string },
	): Promise<void>;
	// Newest first.
	listForChannel(
		tenantId: TenantId,
		channelId: string,
		page: PageQuery,
	): Promise<NotificationDeliveryPage>;
}

// Runs across every tenant: the sweeper serves them all. Audit every caller.
export interface DeliveryOutbox {
	// Like AlertOutbox.claimOverdue: pending deliveries due before their cutoff, oldest first.
	claimOverdue(
		cutoffs: { unsentBefore: Date; sentBefore: Date },
		now: Date,
		limit: number,
	): Promise<DeliveryRef[]>;
}

// Sends the queue messages for an incident event's new deliveries, after its transaction
// commits. Never throws: a delivery left unsent is the sweeper's to send.
export interface DeliveryDispatcher {
	dispatch(tenantId: TenantId, incidentId: IncidentId, event: NotificationEvent): Promise<void>;
}

// The answer to one POST. `retryAfter` is the raw Retry-After header, untrusted.
export type WebhookResult =
	| { kind: "response"; status: number; retryAfter: string | null }
	// No answer. `error` is a fixed description, never the URL or the library's message.
	| { kind: "error"; error: "timeout" | "network error" };

export interface WebhookSender {
	post(url: string, body: unknown): Promise<WebhookResult>;
}

// Which webhook URLs the server will call. Checked when a channel is created and again
// before every send, so the server cannot be pointed at an internal address (SSRF).
export type WebhookPolicy = { allows(url: string): boolean };

export const createWebhookPolicy = (origins: readonly string[]): WebhookPolicy => {
	const allowed = new Set(origins);
	return {
		allows(url) {
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				return false;
			}
			// Credentials in a URL are never needed for a webhook, and hide the real host from a reader.
			if (parsed.username || parsed.password) return false;
			return allowed.has(parsed.origin);
		},
	};
};

// Delivery history is kept this long, then purged by the worker.
export const DELIVERY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface DeliveryPurger {
	// Deletes up to `limit` deliveries created before `cutoff`. Returns how many it deleted.
	purgeOlderThan(cutoff: Date, limit: number): Promise<number>;
}

export interface DeliveryProcessor {
	// Receives and handles one batch of queue messages. Returns how many it received.
	processMessages(): Promise<number>;
	// Re-sends overdue pending deliveries. Returns how many it claimed.
	sweep(): Promise<number>;
}
