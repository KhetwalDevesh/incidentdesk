import type { PageQuery } from "../../contract/common";
import type { IncidentId } from "../../contract/incidents";
import type { AuditEntry } from "../../domain/audit/types";
import { transitionEvent } from "../../domain/events/types";
import type {
	Incident,
	IncidentChanges,
	IncidentExpectation,
	IncidentRepository,
	ReassignOutcome,
	SummaryChange,
} from "../../domain/incidents/types";
import type { DeliveryNotice } from "../../domain/notifications/types";
import type { TenantId } from "../../domain/shared/identity";
import type { DraftRequest } from "../../domain/summaries/types";
import type { InMemoryAccountRepository } from "../accounts/inMemoryAccountRepository";
import { InMemoryAuditStore } from "../audit/inMemoryAuditStore";
import { InMemoryChangeFeed } from "../events/inMemoryChangeFeed";
import { InMemoryNotificationDeliveryRepository } from "../notifications/inMemoryNotificationDeliveryRepository";
import { InMemorySummaryDraftRepository } from "../summaries/inMemorySummaryDraftRepository";

export class InMemoryIncidentRepository implements IncidentRepository {
	private readonly incidents = new Map<IncidentId, Incident>();

	// Shared with the other in-memory repositories, as Postgres shares its tables.
	constructor(
		readonly audit: InMemoryAuditStore = new InMemoryAuditStore(),
		readonly deliveries: InMemoryNotificationDeliveryRepository = new InMemoryNotificationDeliveryRepository(),
		// Without it, the tenant has no members, as for a non-uuid tenant in Postgres.
		private readonly members: InMemoryAccountRepository | null = null,
		readonly feed: InMemoryChangeFeed = new InMemoryChangeFeed(),
		readonly drafts: InMemorySummaryDraftRepository = new InMemorySummaryDraftRepository(feed),
	) {
		// The twin of the member removal unassigning their incidents in its transaction.
		members?.removalHooks.push((tenantId, userIds) => {
			for (const incident of this.incidents.values()) {
				if (
					incident.tenantId === tenantId &&
					incident.assigneeId !== null &&
					userIds.has(incident.assigneeId)
				) {
					this.incidents.set(incident.id, { ...incident, assigneeId: null });
				}
			}
		});
	}

	async create(
		tenantId: TenantId,
		incident: Omit<Incident, "tenantId">,
		audit: AuditEntry[],
		notice?: DeliveryNotice,
		draft?: DraftRequest,
	): Promise<Incident> {
		this.audit.checkSync(audit);
		const stored = { ...incident, tenantId };
		this.incidents.set(stored.id, stored);
		this.audit.appendSync(audit);
		if (notice) this.deliveries.insertSync(tenantId, notice);
		if (draft) this.drafts.insertSync(tenantId, draft);
		this.feed.publishSync({ kind: "incident", tenantId, id: stored.id, event: "incident.opened" });
		return stored;
	}

	async findById(tenantId: TenantId, id: IncidentId): Promise<Incident | null> {
		const incident = this.incidents.get(id);
		return incident?.tenantId === tenantId ? incident : null;
	}

	async list(tenantId: TenantId, { limit, offset }: PageQuery) {
		const owned = [...this.incidents.values()]
			.filter((incident) => incident.tenantId === tenantId)
			// Same order as Postgres: newest first, then id. Lowercase UUID text sorts like its bytes.
			.sort(
				(a, b) =>
					b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			);
		return { items: owned.slice(offset, offset + limit), total: owned.length };
	}

	// Used by InMemoryAlertRepository, the twin of the Postgres grouping upsert. Synchronous,
	// so a caller's lookup and write cannot interleave with another caller.
	findUnresolvedGroupSync(tenantId: TenantId, alertSourceId: string, dedupKey: string) {
		for (const incident of this.incidents.values()) {
			if (
				incident.tenantId === tenantId &&
				incident.alertSourceId === alertSourceId &&
				incident.dedupKey === dedupKey &&
				incident.status !== "resolved"
			) {
				return incident;
			}
		}
		return null;
	}

	// The tenant's incidents, for the dashboard's in-memory twin.
	allSync(tenantId: TenantId): Incident[] {
		return [...this.incidents.values()].filter((incident) => incident.tenantId === tenantId);
	}

	putSync(incident: Incident) {
		this.incidents.set(incident.id, incident);
	}

	// No await between the check and the write, so the compare-and-set is atomic.
	async update(
		tenantId: TenantId,
		id: IncidentId,
		expected: IncidentExpectation,
		changes: IncidentChanges,
		audit: AuditEntry,
		notice?: DeliveryNotice,
	): Promise<Incident | null> {
		const current = this.incidents.get(id);
		if (
			current?.tenantId !== tenantId ||
			current.status !== expected.status ||
			current.assigneeId !== expected.assigneeId
		) {
			return null;
		}
		this.audit.checkSync([audit]);
		const updated = { ...current, ...changes };
		this.incidents.set(id, updated);
		this.audit.appendSync([audit]);
		if (notice) this.deliveries.insertSync(tenantId, notice);
		const event = transitionEvent(changes);
		if (event) this.feed.publishSync({ kind: "incident", tenantId, id, event });
		return updated;
	}

	async setSummary(
		tenantId: TenantId,
		id: IncidentId,
		{ summary, severity }: SummaryChange,
		audit: AuditEntry[],
	): Promise<Incident | null> {
		const current = this.incidents.get(id);
		if (current?.tenantId !== tenantId) return null;
		if (severity && (current.status === "resolved" || current.severity !== severity.from)) {
			return null;
		}
		this.audit.checkSync(audit);
		const updated = { ...current, summary, severity: severity?.to ?? current.severity };
		this.incidents.set(id, updated);
		this.audit.appendSync(audit);
		this.feed.publishSync({ kind: "incident", tenantId, id, event: "incident.updated" });
		return updated;
	}

	async reassign(
		tenantId: TenantId,
		id: IncidentId,
		{ from, to }: { from: string | null; to: string | null },
		audit: AuditEntry,
		notice: DeliveryNotice,
	): Promise<ReassignOutcome> {
		if (to !== null && !this.members?.hasMemberSync(tenantId, to)) {
			return { status: "member_not_found" };
		}
		const current = this.incidents.get(id);
		if (
			current?.tenantId !== tenantId ||
			current.status === "resolved" ||
			current.assigneeId !== from
		) {
			return { status: "changed" };
		}
		this.audit.checkSync([audit]);
		const incident = {
			...current,
			assigneeId: to,
			assignmentCount: current.assignmentCount + 1,
		};
		this.incidents.set(id, incident);
		this.audit.appendSync([audit]);
		this.deliveries.insertSync(tenantId, { ...notice, occurrence: incident.assignmentCount });
		this.feed.publishSync({ kind: "incident", tenantId, id, event: "incident.reassigned" });
		return { status: "reassigned", incident };
	}
}
