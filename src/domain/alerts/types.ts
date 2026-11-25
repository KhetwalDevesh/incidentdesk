import type {
	ALERT_STATES,
	ALERT_STATUSES,
	AlertDetails,
	AlertListQuery,
	AlertPayload,
	CreateAlertSourceRequest,
} from "../../contract/alerts";
import type { PageQuery } from "../../contract/common";
import type { IncidentId, IncidentSeverity } from "../../contract/incidents";
import type { Incident } from "../incidents/types";
import type { Principal, TenantId } from "../shared/identity";
import type { Result } from "../shared/result";

// Spec: docs/features/alert-ingestion.md

export type AlertSource = {
	id: string;
	tenantId: TenantId;
	name: string;
	// The HMAC signing secret, sealed by a SecretBox. The plaintext is never stored.
	secretCiphertext: Uint8Array;
	secretHint: string;
	createdAt: Date;
};

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
	nextAttemptAt: Date;
	// Internal error text. Never leaves the API.
	lastError: string | null;
	incidentId: IncidentId | null;
	receivedAt: Date;
	processedAt: Date | null;
};

export type AlertPage = { items: Alert[]; total: number };

// Tenant-scoped. Every method takes tenantId first, like every repository.
export interface AlertSourceRepository {
	// Returns null when the tenant already has a source with this name.
	create(tenantId: TenantId, source: Omit<AlertSource, "tenantId">): Promise<AlertSource | null>;
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
	// Atomically groups a pending alert and marks it processed, in one transaction:
	// - with a candidate, attaches to the unresolved incident for the alert's source and key,
	//   or inserts the candidate when there is none;
	// - without one, attaches only when such an incident exists.
	// Attaching increments alertCount. Returns null when the alert is no longer pending,
	// so an alert is never grouped twice.
	complete(
		tenantId: TenantId,
		alertId: string,
		candidate: Omit<Incident, "tenantId"> | null,
		processedAt: Date,
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

// Runs across every tenant: the worker serves them all. Audit every caller.
export interface AlertQueue {
	// Claims up to `limit` pending alerts due at `now`, oldest first. Each claim increments
	// attempts and leases the alert until `leaseUntil`, so another worker skips it meanwhile.
	// A worker that dies mid-alert leaves it to be claimed again when the lease ends.
	claimDue(now: Date, limit: number, leaseUntil: Date): Promise<Alert[]>;
}

export interface AlertSignatureVerifier {
	// Constant-time. False for any malformed signature.
	verify(secret: string, timestamp: string, rawBody: Uint8Array, signature: string): boolean;
}

export type CreatedAlertSource = { source: AlertSource; secret: string };

export interface AlertSourceService {
	create(
		principal: Principal,
		input: CreateAlertSourceRequest,
	): Promise<Result<CreatedAlertSource>>;
	list(principal: Principal, page: PageQuery): Promise<Result<AlertSourcePage>>;
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
	// Claims and processes one batch. Returns how many alerts it claimed.
	processBatch(): Promise<number>;
}
