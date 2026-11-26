import { AUDIT_ACTIONS, AUDIT_ACTOR_TYPES, AUDIT_RESOURCE_TYPES } from "../../contract/audit";
import type { PageQuery } from "../../contract/common";
import type {
	AuditEntry,
	AuditEventReader,
	AuditFilter,
	AuditPage,
	AuditPurger,
	AuditRecorder,
	AuditResource,
} from "../../domain/audit/types";
import type { TenantId } from "../../domain/shared/identity";

type Stored = AuditEntry & { seq: number };

const strip = ({ seq: _seq, ...entry }: Stored): AuditEntry => entry;

// Shared by every in-memory repository, as the Postgres twins share the audit_events table.
// A repository calls checkSync before its change and appendSync after it, with no await in
// between, so the change and its entries are atomic like one transaction.
export class InMemoryAuditStore implements AuditEventReader, AuditRecorder, AuditPurger {
	private readonly entries: Stored[] = [];
	private seq = 0;

	// Throws for an entry the audit_events constraints would reject, before anything changes.
	checkSync(entries: AuditEntry[]): void {
		for (const entry of entries) {
			const valid =
				(AUDIT_ACTIONS as readonly string[]).includes(entry.action) &&
				(AUDIT_RESOURCE_TYPES as readonly string[]).includes(entry.resource.type) &&
				(AUDIT_ACTOR_TYPES as readonly string[]).includes(entry.actor.type) &&
				(entry.actor.type === "anonymous") === (entry.actor.id === null) &&
				!this.entries.some(
					(stored) => stored.tenantId === entry.tenantId && stored.id === entry.id,
				);
			if (!valid) throw new Error(`audit entry ${entry.id} violates the audit_events constraints`);
		}
	}

	appendSync(entries: AuditEntry[]): void {
		for (const entry of entries) {
			this.seq += 1;
			this.entries.push({ ...entry, seq: this.seq });
		}
	}

	async record(entry: AuditEntry): Promise<void> {
		this.checkSync([entry]);
		this.appendSync([entry]);
	}

	async list(
		tenantId: TenantId,
		filter: AuditFilter,
		{ limit, offset }: PageQuery,
	): Promise<AuditPage> {
		const matching = this.entries
			.filter(
				(entry) =>
					entry.tenantId === tenantId &&
					(!filter.action || entry.action === filter.action) &&
					(!filter.resourceType || entry.resource.type === filter.resourceType) &&
					(!filter.resourceId || entry.resource.id === filter.resourceId) &&
					(!filter.actorId || entry.actor.id === filter.actorId) &&
					(!filter.from || entry.occurredAt >= filter.from) &&
					(!filter.to || entry.occurredAt <= filter.to),
			)
			// Same order as Postgres: newest first, then latest written.
			.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.seq - a.seq);
		return { items: matching.slice(offset, offset + limit).map(strip), total: matching.length };
	}

	async listForResource(
		tenantId: TenantId,
		resource: AuditResource,
		{ limit, offset }: PageQuery,
	): Promise<AuditPage> {
		const timeline = this.entries
			.filter(
				(entry) =>
					entry.tenantId === tenantId &&
					entry.resource.type === resource.type &&
					entry.resource.id === resource.id,
			)
			.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.seq - b.seq);
		return { items: timeline.slice(offset, offset + limit).map(strip), total: timeline.length };
	}

	async purgeOlderThan(cutoff: Date, limit: number): Promise<number> {
		const old = this.entries
			.filter((entry) => entry.occurredAt < cutoff)
			.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
			.slice(0, limit);
		for (const entry of old) this.entries.splice(this.entries.indexOf(entry), 1);
		return old.length;
	}
}
