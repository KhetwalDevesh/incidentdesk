import { randomUUID } from "node:crypto";
import type { AlertQueue, AlertQueueMessage, AlertRef } from "../domain/alerts/types";

type Stored = {
	id: string;
	body: string;
	visibleAt: number;
	receiveCount: number;
	receipt: string;
};

export type InMemoryAlertQueueOptions = {
	now?: () => Date;
	visibilityTimeoutMs?: number;
	// Matches the SQS redrive policy: a message received this many times goes to the DLQ.
	maxReceiveCount?: number;
};

// Behaves like an SQS standard queue for tests: a received message is hidden for the
// visibility timeout, only its latest receipt can delete it or change its visibility, and a
// message received too often moves to a dead-letter list. Delivery order is send order.
export class InMemoryAlertQueue implements AlertQueue {
	private readonly messages: Stored[] = [];
	readonly deadLetters: string[] = [];
	private readonly now: () => Date;
	private readonly visibilityTimeoutMs: number;
	private readonly maxReceiveCount: number;
	// Lets a test make the queue unavailable.
	failSends = false;

	constructor({
		now = () => new Date(),
		visibilityTimeoutMs = 60_000,
		maxReceiveCount = 10,
	}: InMemoryAlertQueueOptions = {}) {
		this.now = now;
		this.visibilityTimeoutMs = visibilityTimeoutMs;
		this.maxReceiveCount = maxReceiveCount;
	}

	async send(ref: AlertRef): Promise<void> {
		this.sendRaw(JSON.stringify(ref));
	}

	// Sends any body, so tests can deliver malformed messages.
	sendRaw(body: string): void {
		if (this.failSends) throw new Error("queue unavailable");
		this.messages.push({
			id: randomUUID(),
			body,
			visibleAt: this.now().getTime(),
			receiveCount: 0,
			receipt: "",
		});
	}

	async receive(max: number, _waitSeconds: number): Promise<AlertQueueMessage[]> {
		const at = this.now().getTime();
		const received: AlertQueueMessage[] = [];
		for (const message of [...this.messages]) {
			if (received.length >= max) break;
			if (message.visibleAt > at) continue;
			if (message.receiveCount >= this.maxReceiveCount) {
				this.remove(message);
				this.deadLetters.push(message.body);
				continue;
			}
			message.receiveCount += 1;
			message.visibleAt = at + this.visibilityTimeoutMs;
			message.receipt = randomUUID();
			received.push({ id: message.id, receipt: message.receipt, body: message.body });
		}
		return received;
	}

	async delete(message: AlertQueueMessage): Promise<void> {
		const stored = this.current(message);
		if (stored) this.remove(stored);
	}

	async retryAfter(message: AlertQueueMessage, delayMs: number): Promise<void> {
		const stored = this.current(message);
		if (stored) stored.visibleAt = this.now().getTime() + delayMs;
	}

	// Every message not yet deleted, visible or not.
	get size(): number {
		return this.messages.length;
	}

	private current(message: AlertQueueMessage): Stored | undefined {
		return this.messages.find(
			(stored) => stored.id === message.id && stored.receipt === message.receipt,
		);
	}

	private remove(message: Stored): void {
		this.messages.splice(this.messages.indexOf(message), 1);
	}
}
