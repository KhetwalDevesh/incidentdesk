import type { AuditEventResponse } from "../contract/audit";
import type { AuditEntry } from "../domain/audit/types";

// The allowlist of what leaves the API. tenantId never does.
export const toAuditEventResponse = (entry: AuditEntry): AuditEventResponse => ({
	id: entry.id,
	occurredAt: entry.occurredAt.toISOString(),
	action: entry.action,
	actor: { type: entry.actor.type, id: entry.actor.id },
	resource: { type: entry.resource.type, id: entry.resource.id },
	details: { ...entry.details },
	requestId: entry.requestId,
});
