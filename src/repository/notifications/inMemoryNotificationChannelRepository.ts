import type { PageQuery } from "../../contract/common";
import type {
	NotificationChannel,
	NotificationChannelPage,
	NotificationChannelRepository,
} from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";

const byCreatedThenId = (a: NotificationChannel, b: NotificationChannel) =>
	a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Methods do not await between a check and its write, so each one is atomic like its SQL twin.
export class InMemoryNotificationChannelRepository implements NotificationChannelRepository {
	private readonly channels: NotificationChannel[] = [];

	async create(
		tenantId: TenantId,
		channel: Omit<NotificationChannel, "tenantId">,
	): Promise<NotificationChannel | null> {
		const nameTaken = this.channels.some(
			(existing) => existing.tenantId === tenantId && existing.name === channel.name,
		);
		if (nameTaken) return null;
		const created = { ...channel, tenantId };
		this.channels.push(created);
		return created;
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery): Promise<NotificationChannelPage> {
		const owned = this.channels
			.filter((channel) => channel.tenantId === tenantId)
			.sort(byCreatedThenId);
		return { items: owned.slice(offset, offset + limit), total: owned.length };
	}
}
