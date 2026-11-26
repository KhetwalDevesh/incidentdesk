import type {
	ALERT_STATES,
	ALERT_STATUSES,
	AlertDetails,
	AlertListQuery,
	AlertPayload,
	CreateAlertSourceRequest,
	UpdateAlertSourceRequest,
} from "../../contract/alerts";
import type { PageQuery } from "../../contract/common";
import type { IncidentId, IncidentSeverity } from "../../contract/incidents";
import type { AuditEntry } from "../audit/types";
import type { Incident } from "../incidents/types";
import type { DeliveryNotice } from "../notifications/types";
import type { Principal, TenantId } from "../shared/identity";
import type { MessageQueue, QueueMessage } from "../shared/queue";
import type { RequestContext } from "../shared/request";
import type { Result } from "../shared/result";

// Spec: docs/features/alert-ingestion.md

export type AlertSource = {
	id: string;
	tenantId: TenantId;
	name: string;
	// The HMAC signing secret, sealed by a SecretBox. The plaintext is never stored.
	secretCiphertext: Uint8Array;
	secretHint: string;
	// The schedule that assigns its incidents. Null: the tenant's default schedule.
	onCallScheduleId: string | null;
	createdAt: Date;
};

export type AlertSourceWriteOutcome =
	| { status: "saved"; source: AlertSource }
	| { status: "not_found" }
	| { status: "name_taken" }
	// onCallScheduleId names no schedule of the tenant.
	| { status: "schedule_not_found" };

export type AlertSourcePage = { items: AlertSource[]; total: number };

// The context a source's signing secret is sealed under.
export const alertSourceSecretContext = (tenantId: TenantId, sourceId: string) =>
	`alert_source:${tenantId}:${sourceId}`;

export type Alert = {
	id: string;
	tenantId: TenantId;
	sourceId: string;
	dedupKey: string;
	status: (typeof ALERT_STATUSES)[number];
	title: string;
	severity: IncidentSeverity;
	details: AlertDetails;
	state: (typeof ALERT_STATES)[number];
	attempts: number;
	// When this alert should have been handled by. The sweeper re-sends a pending alert only
	// once this is overdue by its cutoff. See docs/features/alert-queue-sqs.md.
	nextAttemptAt: Date;
	// Internal error text. Never leaves the API.
	lastError: string | null;
	incidentId: IncidentId | null;
	receivedAt: Date;
	processedAt: Date | null;
	// When a queue message for this alert was last confirmed sent. Null until one is.
	sentAt: Date | null;
};

export type AlertPage = { items: Alert[]; total: number };

// What a queue message carries. The alerts row stays the source of truth for everything else.
export type AlertRef = { tenantId: TenantId; alertId: string };

// The message body for a ref: the two ids and nothing else, even if a caller passes more.
export const alertQueueBody = ({ tenantId, alertId }: AlertRef) => ({ tenantId, alertId });

// Tenant-scoped. Every method takes tenantId first, like every repository.
export interface AlertSourceRepository {
	create(
		tenantId: TenantId,
		source: Omit<AlertSource, "tenantId">,
		// Written only when the source is created.
		audit: AuditEntry,
	): Promise<AlertSourceWriteOutcome>;
	// Links the source to a schedule, or unlinks it with null.
	link(
		tenantId: TenantId,
		id: string,
		onCallScheduleId: string | null,
		audit: AuditEntry,
	): Promise<AlertSourceWriteOutcome>;
	list(tenantId: TenantId, page: PageQuery): Promise<AlertSourcePage>;
}

// Runs before the tenant is known: the webhook path names only a source id. Audit every caller.
export interface AlertSourceLookup {
	findForIngest(sourceId: string): Promise<AlertSource | null>;
}

// Tenant-scoped. Every method takes tenantId first, like every repository.
export interface AlertRepository {
	enqueue(tenantId: TenantId, alert: Omit<Alert, "tenantId">): Promise<Alert>;
	// Newest first.
	list(tenantId: TenantId, query: AlertListQuery): Promise<AlertPage>;
	// Records that a queue message for the alert was sent.
	markSent(tenantId: TenantId, alertId: string, sentAt: Date): Promise<void>;
	// Starts an attempt on a pending alert: increments attempts and moves nextAttemptAt to
	// `leaseUntil`, so the sweeper leaves it alone while it is in flight. Returns null when the
	// alert is unknown or no longer pending, which makes a duplicate message a no-op.
	startAttempt(tenantId: TenantId, alertId: string, leaseUntil: Date): Promise<Alert | null>;
	// Atomically groups a pending alert and marks it processed, in one transaction:
	// - with a candidate, attaches to the unresolved incident for the alert's source and key,
	//   or inserts the candidate when there is none;
	// - without one, attaches only when such an incident exists.
	// Attaching increments alertCount. Returns null when the alert is no longer pending,
	// so an alert is never grouped twice. `audit` builds the entries for the outcome, which
	// are written in the same transaction.
	complete(
		tenantId: TenantId,
		alertId: string,
		candidate: Omit<Incident, "tenantId"> | null,
		processedAt: Date,
		audit: (outcome: GroupingOutcome) => AuditEntry[],
		// The Slack deliveries for the outcome, written in the same transaction.
		notice?: (outcome: GroupingOutcome) => DeliveryNotice | null,
	): Promise<{ incidentId: IncidentId | null } | null>;
	// Records a failed attempt. A null retryAt marks the alert failed for good.
	fail(
		tenantId: TenantId,
		alertId: string,
		error: string,
		retryAt: Date | null,
		now: Date,
	): Promise<void>;
}

// What complete() did: attached to, or opened, an incident. incidentId is null when a
// resolved alert found no unresolved incident to attach to.
export type GroupingOutcome = { incidentId: IncidentId | null; opened: boolean };

// Runs across every tenant: the sweeper serves them all. Audit every caller.
export interface AlertOutbox {
	// Claims up to `limit` pending alerts, oldest first, whose nextAttemptAt is at or before
	// `unsentBefore` when they were never sent, or at or before `sentBefore` when they were.
	// Each claim moves nextAttemptAt to `now`, so a concurrent sweeper skips it.
	claimOverdue(
		cutoffs: { unsentBefore: Date; sentBefore: Date },
		now: Date,
		limit: number,
	): Promise<AlertRef[]>;
}

// The alert queue: the shared queue shape, carrying alert refs.
export type AlertQueueMessage = QueueMessage;
export type AlertQueue = MessageQueue<AlertRef>;

export interface AlertSignatureVerifier {
	// Constant-time. False for any malformed signature.
	verify(secret: string, timestamp: string, rawBody: Uint8Array, signature: string): boolean;
}

export type CreatedAlertSource = { source: AlertSource; secret: string };

export interface AlertSourceService {
	create(
		principal: Principal,
		input: CreateAlertSourceRequest,
		context?: RequestContext,
	): Promise<Result<CreatedAlertSource>>;
	list(principal: Principal, page: PageQuery): Promise<Result<AlertSourcePage>>;
	update(
		principal: Principal,
		id: string,
		input: UpdateAlertSourceRequest,
		context?: RequestContext,
	): Promise<Result<AlertSource>>;
}

export interface AlertService {
	list(principal: Principal, query: AlertListQuery): Promise<Result<AlertPage>>;
}

// Proof that a webhook request's signature was checked. Only AlertIngestService.verify makes one,
// so enqueue cannot be reached with an unverified source.
declare const verified: unique symbol;
export type VerifiedAlertSource = AlertSource & { readonly [verified]: true };

export type AlertWebhookRequest = {
	sourceId: string;
	timestamp: string | undefined;
	signature: string | undefined;
	rawBody: Uint8Array;
};

export interface AlertIngestService {
	// Checks the source, timestamp and signature, before the body is parsed.
	verify(request: AlertWebhookRequest): Promise<Result<VerifiedAlertSource>>;
	enqueue(source: VerifiedAlertSource, payload: AlertPayload): Promise<Result<Alert>>;
}

export interface AlertProcessor {
	// Receives and handles one batch of queue messages. Returns how many it received.
	processMessages(): Promise<number>;
	// Re-sends overdue pending alerts. Returns how many it claimed.
	sweep(): Promise<number>;
}
