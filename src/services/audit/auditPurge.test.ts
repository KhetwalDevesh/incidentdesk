import { describe, expect, it } from "vitest";
import { AUDIT_RETENTION_MS, type AuditPurger } from "../../domain/audit/types";
import { createAuditPurge } from "./auditPurge";

const now = new Date("2026-06-01T00:00:00.000Z");

// Hands out `remaining` deletions, `limit` at a time, and records each call.
const fakePurger = (remaining: number) => {
	const calls: { cutoff: Date; limit: number }[] = [];
	const purger: AuditPurger = {
		async purgeOlderThan(cutoff, limit) {
			calls.push({ cutoff, limit });
			const count = Math.min(limit, remaining);
			remaining -= count;
			return count;
		},
	};
	return { purger, calls };
};

describe("audit purge", () => {
	it("deletes in batches until a batch comes back short, using a 90-day cutoff", async () => {
		const { purger, calls } = fakePurger(25);

		const deleted = await createAuditPurge({ purger, now: () => now, batchSize: 10 })();

		expect(deleted).toBe(25);
		expect(calls.map((call) => call.limit)).toEqual([10, 10, 10]);
		expect(calls[0]?.cutoff).toEqual(new Date(now.getTime() - AUDIT_RETENTION_MS));
		expect(AUDIT_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
	});

	it("stops after maxBatches, leaving the rest for the next run", async () => {
		const { purger, calls } = fakePurger(1000);

		const deleted = await createAuditPurge({
			purger,
			now: () => now,
			batchSize: 10,
			maxBatches: 3,
		})();

		expect(deleted).toBe(30);
		expect(calls).toHaveLength(3);
	});
});
