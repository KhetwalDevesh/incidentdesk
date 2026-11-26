import type { PageQuery } from "../../contract/common";
import type { AuditEntry } from "../../domain/audit/types";
import type {
	NotificationChannel,
	NotificationChannelPage,
	NotificationChannelRepository,
} from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";
import { InMemoryAuditStore } from "../audit/inMemoryAuditStore";

const byCreatedThenId = (a: NotificationChannel, b: NotificationChannel) =>
	a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Methods do not await between a check and its write, so each one is atomic like its SQL twin.
export class InMemoryNotificationChannelRepository implements NotificationChannelRepository {
	private readonly channels: NotificationChannel[] = [];

	constructor(readonly audit: InMemoryAuditStore = new InMemoryAuditStore()) {}

	async create(
		tenantId: TenantId,
		channel: Omit<NotificationChannel, "tenantId">,
		audit: AuditEntry,
	): Promise<NotificationChannel | null> {
		const nameTaken = this.channels.some(
			(existing) => existing.tenantId === tenantId && existing.name === channel.name,
		);
		if (nameTaken) return null;
		this.audit.checkSync([audit]);
		const created = { ...channel, tenantId };
		this.channels.push(created);
		this.audit.appendSync([audit]);
		return created;
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery): Promise<NotificationChannelPage> {
		const owned = this.channels
			.filter((channel) => channel.tenantId === tenantId)
			.sort(byCreatedThenId);
		return { items: owned.slice(offset, offset + limit), total: owned.length };
	}

	async findById(tenantId: TenantId, id: string): Promise<NotificationChannel | null> {
		return (
			this.channels.find((channel) => channel.tenantId === tenantId && channel.id === id) ?? null
		);
	}

	// Used by InMemoryNotificationDeliveryRepository, the twin of its INSERT ... SELECT.
	allSync(tenantId: TenantId): NotificationChannel[] {
		return this.channels.filter((channel) => channel.tenantId === tenantId).sort(byCreatedThenId);
	}
}
