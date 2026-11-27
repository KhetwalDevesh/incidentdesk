import type { LoginThrottle, ThrottleOutcome, ThrottleRule } from "../../domain/auth/types";

type Entry = { windowStartedAt: Date; count: number; lockedUntil: Date | null; updatedAt: Date };

// The twin of the Postgres throttle. record has no await, so it is atomic like its statement.
export class InMemoryLoginThrottle implements LoginThrottle {
	private readonly entries = new Map<string, Entry>();

	async lockedUntil(keys: string[], now: Date): Promise<Date | null> {
		let latest: Date | null = null;
		for (const key of keys) {
			const until = this.entries.get(key)?.lockedUntil;
			if (until && until > now && (!latest || until > latest)) latest = until;
		}
		return latest;
	}

	async record(key: string, rule: ThrottleRule, now: Date): Promise<ThrottleOutcome> {
		const current = this.entries.get(key);
		const expired = !current || current.windowStartedAt.getTime() <= now.getTime() - rule.windowMs;
		const count = expired ? 1 : current.count + 1;
		const lockEnd = new Date(now.getTime() + rule.lockMs);
		const inForce = current?.lockedUntil && current.lockedUntil > now ? current.lockedUntil : null;
		const lockedUntil = inForce ?? (count >= rule.limit ? lockEnd : null);
		this.entries.set(key, {
			windowStartedAt: expired ? now : current.windowStartedAt,
			count,
			lockedUntil,
			updatedAt: now,
		});
		// A lock starts only when none was in force before this event.
		return { count, lockedUntil, lockedNow: lockedUntil !== null && inForce === null };
	}

	async clear(key: string): Promise<void> {
		this.entries.delete(key);
	}

	async purgeOlderThan(cutoff: Date, limit: number): Promise<number> {
		let deleted = 0;
		for (const [key, entry] of this.entries) {
			if (deleted >= limit) break;
			if (entry.updatedAt < cutoff && (!entry.lockedUntil || entry.lockedUntil < cutoff)) {
				this.entries.delete(key);
				deleted += 1;
			}
		}
		return deleted;
	}
}
