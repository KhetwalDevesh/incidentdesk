import { randomUUID } from "node:crypto";
import type { GroupingOutcome } from "../src/domain/alerts/types";
import type { AuditAction, AuditEntry } from "../src/domain/audit/types";
import type { User } from "../src/domain/auth/types";
import type { TenantId } from "../src/domain/shared/identity";

// A valid audit entry for repository tests, which care that it is stored with the change,
// not what it says. Override any field to check it round-trips.
export const anAudit = (
	tenantId: TenantId,
	action: AuditAction = "incident.created",
	overrides: Partial<AuditEntry> = {},
): AuditEntry => ({
	id: randomUUID(),
	tenantId,
	occurredAt: new Date(),
	action,
	actor: { type: "user", id: "user-1" },
	resource: { type: "incident", id: randomUUID() },
	details: {},
	requestId: null,
	...overrides,
});

// The audit argument for redeemSetupToken: an entry for whoever redeemed the token.
export const setupAudit = (user: User): AuditEntry =>
	anAudit(user.tenantId, "member.setup_completed", {
		actor: { type: "user", id: user.id },
		resource: { type: "user", id: user.id },
	});

// The audit argument for complete(): one alert.grouped entry when an incident was touched.
export const groupingAudit =
	(tenantId: TenantId) =>
	({ incidentId }: GroupingOutcome): AuditEntry[] =>
		incidentId
			? [anAudit(tenantId, "alert.grouped", { resource: { type: "incident", id: incidentId } })]
			: [];
