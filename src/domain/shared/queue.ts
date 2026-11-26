// A received message. `body` is untrusted until parsed. `receipt` identifies this delivery.
export type QueueMessage = { id: string; receipt: string; body: string };

// A queue of small id-only messages. Delivery is at least once: a message can arrive more
// than once, in any order. The alert and notification queues are both one of these.
export interface MessageQueue<T> {
	send(message: T): Promise<void>;
	// Waits up to `waitSeconds` for messages. A received message stays hidden from other
	// receivers for the queue's visibility timeout, then comes back unless deleted.
	receive(max: number, waitSeconds: number): Promise<QueueMessage[]>;
	delete(message: QueueMessage): Promise<void>;
	// Hides the message for `delayMs` from now, so it is redelivered then.
	retryAfter(message: QueueMessage, delayMs: number): Promise<void>;
}
