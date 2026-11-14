import type { PageQuery } from "../../contract/common";
import type { IncidentSeverity } from "../../contract/incidents";
import type {
	CreateNotificationChannelRequest,
	NOTIFICATION_CHANNEL_KINDS,
} from "../../contract/notificationChannels";
import type { Principal, TenantId } from "../shared/identity";
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
	): Promise<NotificationChannel | null>;
	list(tenantId: TenantId, page: PageQuery): Promise<NotificationChannelPage>;
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
	): Promise<Result<NotificationChannel>>;
	list(principal: Principal, page: PageQuery): Promise<Result<NotificationChannelPage>>;
}
