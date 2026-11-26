import { randomUUID } from "node:crypto";
import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import {
	type AttemptStart,
	type DeliveryFailureReason,
	type DeliveryNotice,
	type DeliveryOutbox,
	type DeliveryPayload,
	type DeliveryPurger,
	type DeliveryRef,
	meetsMinSeverity,
	type NotificationDelivery,
	type NotificationDeliveryPage,
	type NotificationDeliveryRepository,
	type NotificationEvent,
} from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";
import { InMemoryNotificationChannelRepository } from "./inMemoryNotificationChannelRepository";

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const withoutEmail = (payload: DeliveryPayload): DeliveryPayload =>
	payload.actor.type === "user" ? { ...payload, actor: { type: "user", email: null } } : payload;

// The twin of the Postgres repository. The incident and alert repositories call insertSync
// inside their own change, with no await in between, so the change and its deliveries are
// atomic like one transaction. Methods do not await between a check and its write.
export class InMemoryNotificationDeliveryRepository
	implements NotificationDeliveryRepository, DeliveryOutbox, DeliveryPurger
{
	private readonly deliveries = new Map<string, NotificationDelivery>();

	// Shares the channel store, as the Postgres twin shares the database.
	constructor(
		readonly channels: InMemoryNotificationChannelRepository = new InMemoryNotificationChannelRepository(),
		private readonly newId: () => string = randomUUID,
	) {}

	insertSync(tenantId: TenantId, notice: DeliveryNotice): void {
		for (const channel of this.channels.allSync(tenantId)) {
			if (!channel.enabled || !meetsMinSeverity(notice.severity, channel.minSeverity)) continue;
			const duplicate = [...this.deliveries.values()].some(
				(delivery) =>
					delivery.tenantId === tenantId &&
					delivery.channelId === channel.id &&
					delivery.incidentId === notice.incidentId &&
					delivery.event === notice.event,
			);
			if (duplicate) continue;
			const id = this.newId();
			this.deliveries.set(id, {
				id,
				tenantId,
				channelId: channel.id,
				incidentId: notice.incidentId,
				event: notice.event,
				payload: notice.payload,
				state: "pending",
				attempts: 0,
				nextAttemptAt: notice.createdAt,
				sentAt: null,
				failureReason: null,
				lastStatus: null,
				lastError: null,
				createdAt: notice.createdAt,
				deliveredAt: null,
			});
		}
	}

	// For tests: every stored delivery, as Postgres would return it.
	allSync(): NotificationDelivery[] {
		return [...this.deliveries.values()];
	}

	async listUnsent(
		tenantId: TenantId,
		incidentId: IncidentId,
		event: NotificationEvent,
	): Promise<DeliveryRef[]> {
		return [...this.deliveries.values()]
			.filter(
				(delivery) =>
					delivery.tenantId === tenantId &&
					delivery.incidentId === incidentId &&
					delivery.event === event &&
					delivery.state === "pending" &&
					delivery.sentAt === null,
			)
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a.id, b.id))
			.slice(0, 1000)
			.map((delivery) => ({ tenantId, deliveryId: delivery.id }));
	}

	async markSent(tenantId: TenantId, deliveryId: string, sentAt: Date): Promise<void> {
		const delivery = this.owned(tenantId, deliveryId);
		if (delivery) this.deliveries.set(deliveryId, { ...delivery, sentAt });
	}

	async startAttempt(
		tenantId: TenantId,
		deliveryId: string,
		now: Date,
		leaseUntil: Date,
	): Promise<AttemptStart> {
		const delivery = this.owned(tenantId, deliveryId);
		if (delivery?.state !== "pending") return null;
		if (delivery.nextAttemptAt > now) return { status: "leased", until: delivery.nextAttemptAt };
		const started = { ...delivery, attempts: delivery.attempts + 1, nextAttemptAt: leaseUntil };
		this.deliveries.set(deliveryId, started);
		return { status: "started", delivery: started };
	}

	async deliver(tenantId: TenantId, deliveryId: string, status: number, at: Date): Promise<void> {
		const delivery = this.owned(tenantId, deliveryId);
		if (delivery?.state !== "pending") return;
		this.deliveries.set(deliveryId, {
			...delivery,
			state: "delivered",
			deliveredAt: at,
			lastStatus: status,
			lastError: null,
			payload: withoutEmail(delivery.payload),
		});
	}

	async retry(
		tenantId: TenantId,
		deliveryId: string,
		{
			retryAt,
			counted,
			status,
			error,
		}: { retryAt: Date; counted: boolean; status: number | null; error: string },
	): Promise<void> {
		const delivery = this.owned(tenantId, deliveryId);
		if (delivery?.state !== "pending") return;
		this.deliveries.set(deliveryId, {
			...delivery,
			nextAttemptAt: retryAt,
			lastStatus: status,
			lastError: error,
			attempts: counted ? delivery.attempts : Math.max(delivery.attempts - 1, 0),
		});
	}

	async fail(
		tenantId: TenantId,
		deliveryId: string,
		{
			reason,
			status,
			error,
		}: { reason: DeliveryFailureReason; status: number | null; error: string },
	): Promise<void> {
		const delivery = this.owned(tenantId, deliveryId);
		if (delivery?.state !== "pending") return;
		this.deliveries.set(deliveryId, {
			...delivery,
			state: "failed",
			failureReason: reason,
			lastStatus: status,
			lastError: error,
			payload: withoutEmail(delivery.payload),
		});
	}

	async listForChannel(
		tenantId: TenantId,
		channelId: string,
		{ limit, offset }: PageQuery,
	): Promise<NotificationDeliveryPage> {
		const owned = [...this.deliveries.values()]
			.filter((delivery) => delivery.tenantId === tenantId && delivery.channelId === channelId)
			// Same order as Postgres: newest first, then id.
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareIds(a.id, b.id));
		return { items: owned.slice(offset, offset + limit), total: owned.length };
	}

	async claimOverdue(
		{ unsentBefore, sentBefore }: { unsentBefore: Date; sentBefore: Date },
		now: Date,
		limit: number,
	): Promise<DeliveryRef[]> {
		const overdue = [...this.deliveries.values()]
			.filter(
				(delivery) =>
					delivery.state === "pending" &&
					delivery.nextAttemptAt <= (delivery.sentAt === null ? unsentBefore : sentBefore),
			)
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a.id, b.id))
			.slice(0, limit);
		return overdue.map((delivery) => {
			this.deliveries.set(delivery.id, { ...delivery, nextAttemptAt: now });
			return { tenantId: delivery.tenantId, deliveryId: delivery.id };
		});
	}

	async purgeOlderThan(cutoff: Date, limit: number): Promise<number> {
		const old = [...this.deliveries.values()]
			.filter((delivery) => delivery.createdAt < cutoff)
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
			.slice(0, limit);
		for (const delivery of old) this.deliveries.delete(delivery.id);
		return old.length;
	}

	private owned(tenantId: TenantId, deliveryId: string) {
		const delivery = this.deliveries.get(deliveryId);
		return delivery?.tenantId === tenantId ? delivery : null;
	}
}
