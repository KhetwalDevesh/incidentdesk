import { AUDIT_RETENTION_MS, type AuditPurger } from "../../domain/audit/types";

export type AuditPurgeDeps = {
	purger: AuditPurger;
	// Notification deliveries reuse this purge with their own retention.
	retentionMs?: number;
	now?: () => Date;
	batchSize?: number;
	// Caps one run, so a huge backlog is worked off over several runs.
	maxBatches?: number;
};

// Deletes audit entries past the 90-day retention, in batches. Returns how many it deleted.
// The audit_events trigger refuses anything younger, so a wrong clock cannot purge early.
export const createAuditPurge =
	({
		purger,
		retentionMs = AUDIT_RETENTION_MS,
		now = () => new Date(),
		batchSize = 1000,
		maxBatches = 100,
	}: AuditPurgeDeps) =>
	async (): Promise<number> => {
		const cutoff = new Date(now().getTime() - retentionMs);
		let deleted = 0;
		for (let batch = 0; batch < maxBatches; batch++) {
			const count = await purger.purgeOlderThan(cutoff, batchSize);
			deleted += count;
			if (count < batchSize) break;
		}
		return deleted;
	};
