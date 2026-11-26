import { randomUUID } from "node:crypto";
import type { IncidentId } from "../../contract/incidents";
import { auditEntry, auditOrigin } from "../../domain/audit/types";
import type { AccountRepository } from "../../domain/auth/types";
import type { Incident, IncidentRepository, IncidentService } from "../../domain/incidents/types";
import type {
	DeliveryDispatcher,
	DeliveryNotice,
	NotificationEvent,
} from "../../domain/notifications/types";
import { canRespond, type Principal } from "../../domain/shared/identity";
import { fail, ok } from "../../domain/shared/result";
import { NO_DISPATCH } from "../notifications/deliveryDispatcher";

export type IncidentServiceDeps = {
	now?: () => Date;
	// Looks up the acting member's email for the Slack message.
	members?: Pick<AccountRepository, "findUser">;
	// Sends the queue messages for the change's Slack deliveries, after it commits.
	dispatcher?: DeliveryDispatcher;
};

export const createIncidentService = (
	repository: IncidentRepository,
	{ now = () => new Date(), members, dispatcher = NO_DISPATCH }: IncidentServiceDeps = {},
): IncidentService => {
	// The Slack message for a member's change. The email is copied now, as it is at this
	// moment, so the message names the member even if they are removed before it is sent.
	// Spec: docs/features/slack-delivery.md.
	const noticeFor = async (
		principal: Principal,
		incident: Incident,
		event: NotificationEvent,
		at: Date,
	): Promise<DeliveryNotice> => {
		const member = await members?.findUser(principal.tenantId, principal.userId);
		return {
			incidentId: incident.id,
			event,
			severity: incident.severity,
			createdAt: at,
			payload: {
				title: incident.title,
				severity: incident.severity,
				actor: { type: "user", email: member?.email ?? null },
				alertCount: incident.alertCount,
				openedAt: incident.createdAt.toISOString(),
				occurredAt: at.toISOString(),
			},
		};
	};

	return {
		async create(principal, input, context) {
			if (!canRespond(principal)) {
				return fail("FORBIDDEN", "Your role cannot create incidents");
			}
			const id = randomUUID() as IncidentId;
			const createdAt = now();
			const opened: Omit<Incident, "tenantId"> = {
				id,
				title: input.title,
				severity: input.severity,
				status: "open",
				createdAt,
				createdBy: principal.userId,
				acknowledgedAt: null,
				acknowledgedBy: null,
				resolvedAt: null,
				resolvedBy: null,
				alertSourceId: null,
				dedupKey: null,
				alertCount: 0,
				lastAlertAt: null,
			};
			const incident = await repository.create(
				principal.tenantId,
				opened,
				auditEntry(
					auditOrigin(createdAt, context),
					principal.tenantId,
					"incident.created",
					{ type: "user", id: principal.userId },
					{ type: "incident", id },
					{ title: input.title, severity: input.severity },
				),
				await noticeFor(
					principal,
					{ ...opened, tenantId: principal.tenantId },
					"incident.opened",
					createdAt,
				),
			);
			await dispatcher.dispatch(principal.tenantId, id, "incident.opened");
			return ok(incident);
		},

		async acknowledge(principal, id, context) {
			if (!canRespond(principal)) {
				return fail("FORBIDDEN", "Your role cannot acknowledge incidents");
			}
			const incident = await repository.findById(principal.tenantId, id);
			if (!incident) return fail("NOT_FOUND", "Incident not found");
			if (incident.status !== "open") {
				return fail("CONFLICT", `Incident is ${incident.status}, not open`);
			}
			const at = now();
			const updated = await repository.update(
				principal.tenantId,
				id,
				"open",
				{ status: "acknowledged", acknowledgedAt: at, acknowledgedBy: principal.userId },
				auditEntry(
					auditOrigin(at, context),
					principal.tenantId,
					"incident.acknowledged",
					{ type: "user", id: principal.userId },
					{ type: "incident", id },
					{},
				),
				await noticeFor(principal, incident, "incident.acknowledged", at),
			);
			// null means a concurrent request changed the status after our read.
			if (!updated) return fail("CONFLICT", "Incident is no longer open");
			await dispatcher.dispatch(principal.tenantId, id, "incident.acknowledged");
			return ok(updated);
		},

		async resolve(principal, id, context) {
			if (!canRespond(principal)) {
				return fail("FORBIDDEN", "Your role cannot resolve incidents");
			}
			const incident = await repository.findById(principal.tenantId, id);
			if (!incident) return fail("NOT_FOUND", "Incident not found");
			if (incident.status === "resolved") {
				return fail("CONFLICT", "Incident is already resolved");
			}
			// Expect the status we read, so a concurrent acknowledge or resolve makes this one lose.
			const at = now();
			const updated = await repository.update(
				principal.tenantId,
				id,
				incident.status,
				{ status: "resolved", resolvedAt: at, resolvedBy: principal.userId },
				auditEntry(
					auditOrigin(at, context),
					principal.tenantId,
					"incident.resolved",
					{ type: "user", id: principal.userId },
					{ type: "incident", id },
					{},
				),
				await noticeFor(principal, incident, "incident.resolved", at),
			);
			if (!updated) return fail("CONFLICT", "Incident changed while resolving");
			await dispatcher.dispatch(principal.tenantId, id, "incident.resolved");
			return ok(updated);
		},

		async get(principal, id) {
			const incident = await repository.findById(principal.tenantId, id);
			return incident ? ok(incident) : fail("NOT_FOUND", "Incident not found");
		},

		async list(principal, page) {
			return ok(await repository.list(principal.tenantId, page));
		},
	};
};
