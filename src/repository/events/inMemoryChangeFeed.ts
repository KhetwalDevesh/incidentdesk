import type { ChangeFeed, ChangeNotice, FeedItem } from "../../domain/events/types";

// The twin of NOTIFY and LISTEN. In-memory repositories publish at the point their change
// applies, as Postgres delivers on commit.
export class InMemoryChangeFeed implements ChangeFeed {
	private readonly listeners = new Set<(item: FeedItem) => void>();
	// For tests: every notice published, in order.
	readonly published: ChangeNotice[] = [];

	subscribe(listener: (item: FeedItem) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	publishSync(notice: ChangeNotice): void {
		this.published.push(notice);
		for (const listener of this.listeners) listener(notice);
	}

	// For tests: as the Postgres feed does after its listening connection comes back.
	resync(): void {
		for (const listener of this.listeners) listener({ kind: "resync" });
	}
}
