import type {
	DeliveryDispatcher,
	NotificationDeliveryRepository,
	NotificationQueue,
} from "../../domain/notifications/types";

export type DeliveryDispatcherDeps = {
	deliveries: NotificationDeliveryRepository;
	queue: NotificationQueue;
	now?: () => Date;
	// Gets the delivery id only. A failed send is not an error for the caller: the row is
	// saved, and the sweeper sends it later.
	onSendError?: (deliveryId: string, error: unknown) => void;
};

// Runs after the incident change commits, as the alert webhook sends after its insert.
// Spec: docs/features/slack-delivery.md, user flow step 2.
export const createDeliveryDispatcher = ({
	deliveries,
	queue,
	now = () => new Date(),
	onSendError = () => undefined,
}: DeliveryDispatcherDeps): DeliveryDispatcher => ({
	async dispatch(tenantId, incidentId, event) {
		let refs: Awaited<ReturnType<NotificationDeliveryRepository["listUnsent"]>>;
		try {
			refs = await deliveries.listUnsent(tenantId, incidentId, event);
		} catch (error) {
			onSendError(`incident ${incidentId} ${event}`, error);
			return;
		}
		for (const ref of refs) {
			try {
				await queue.send(ref);
				await deliveries.markSent(ref.tenantId, ref.deliveryId, now());
			} catch (error) {
				onSendError(ref.deliveryId, error);
			}
		}
	},
});

// For callers with no notifications wired, such as unit tests of other services.
export const NO_DISPATCH: DeliveryDispatcher = { dispatch: async () => undefined };
