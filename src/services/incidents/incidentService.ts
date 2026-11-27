import { randomUUID } from "node:crypto";
import type { IncidentId } from "../../contract/incidents";
import { type AuditEntry, auditEntry, auditOrigin } from "../../domain/audit/types";
import type { AccountRepository } from "../../domain/auth/types";
import {
	type Incident,
	type IncidentRepository,
	type IncidentService,
	type IncidentView,
	mayActOn,
} from "../../domain/incidents/types";
import type {
	DeliveryDispatcher,
	DeliveryNotice,
	DeliveryPayload,
	NotificationEvent,
} from "../../domain/notifications/types";
import type { OnCallAssigner } from "../../domain/onCall/types";
import { isAdmin, type Principal, type TenantId } from "../../domain/shared/identity";
import type { RequestContext } from "../../domain/shared/request";
import { fail, ok, type Result } from "../../domain/shared/result";
import { NO_DISPATCH } from "../notifications/deliveryDispatcher";
import { NO_ASSIGNER } from "../onCall/onCallAssigner";

export type IncidentServiceDeps = {
	now?: () => Date;
	// Reads members' emails: the actor's for Slack, and the assignee's for responses.
	members?: Pick<AccountRepository, "findUser" | "findUsers">;
	// Sends the queue messages for the change's Slack deliveries, after it commits.
	dispatcher?: DeliveryDispatcher;
	// Picks the assignee of an incident a person opens. Spec: docs/features/on-call-schedules.md.
	onCall?: OnCallAssigner;
};

const NONE = "none";

// Adds each assignee's email, read now, so a response always shows the current one. Shared
// with the realtime hub, which shows incidents exactly as the API does.
export const createIncidentViews =
	(members: Pick<AccountRepository, "findUsers"> | undefined) =>
	async (tenantId: TenantId, incidents: Incident[]): Promise<IncidentView[]> => {
		const ids = incidents.flatMap((incident) => (incident.assigneeId ? [incident.assigneeId] : []));
		const found = ids.length > 0 && members ? await members.findUsers(tenantId, ids) : [];
		const emails = new Map(found.map((user) => [user.id, user.email]));
		return incidents.map((incident) => {
			const email = incident.assigneeId ? emails.get(incident.assigneeId) : undefined;
			return {
				...incident,
				assignee:
					incident.assigneeId && email !== undefined ? { id: incident.assigneeId, email } : null,
			};
		});
	};

export const createIncidentService = (
	repository: IncidentRepository,
	{
		now = () => new Date(),
		members,
		dispatcher = NO_DISPATCH,
		onCall = NO_ASSIGNER,
	}: IncidentServiceDeps = {},
): IncidentService => {
	const emailOf = async (tenantId: TenantId, userId: string) =>
		(await members?.findUser(tenantId, userId))?.email ?? null;

	const views = createIncidentViews(members);

	const view = async (incident: Incident) =>
		(await views(incident.tenantId, [incident]))[0] as IncidentView;

	// The Slack message for a member's change. Emails are copied now, as they are at this
	// moment, so the message names the member even if they are removed before it is sent.
	// Spec: docs/features/slack-delivery.md.
	const noticeFor = async (
		principal: Principal,
		incident: Incident,
		event: NotificationEvent,
		at: Date,
		assignee?: DeliveryPayload["assignee"],
	): Promise<DeliveryNotice> => ({
		incidentId: incident.id,
		event,
		severity: incident.severity,
		createdAt: at,
		payload: {
			title: incident.title,
			severity: incident.severity,
			actor: { type: "user", email: await emailOf(principal.tenantId, principal.userId) },
			alertCount: incident.alertCount,
			openedAt: incident.createdAt.toISOString(),
			occurredAt: at.toISOString(),
			...(assignee === undefined ? {} : { assignee }),
		},
	});

	const assignedEntry = (
		principal: Principal,
		id: IncidentId,
		at: Date,
		context: RequestContext | undefined,
		details: { from: string | null; to: string | null; manual: boolean },
	): AuditEntry =>
		auditEntry(
			auditOrigin(at, context),
			principal.tenantId,
			"incident.assigned",
			{ type: "user", id: principal.userId },
			{ type: "incident", id },
			{
				from: details.from ?? NONE,
				to: details.to ?? NONE,
				manual: details.manual ? "true" : "false",
			},
		);

	// Acknowledge and resolve: only the assignee or an admin may act on an assigned incident.
	const transition = async (
		principal: Principal,
		id: IncidentId,
		context: RequestContext | undefined,
		kind: "acknowledge" | "resolve",
	): Promise<Result<IncidentView>> => {
		const incident = await repository.findById(principal.tenantId, id);
		if (!incident) return fail("NOT_FOUND", "Incident not found");
		if (!mayActOn(incident, principal)) {
			return fail("FORBIDDEN", `Only the assignee or an admin can ${kind} this incident`);
		}
		if (kind === "acknowledge" && incident.status !== "open") {
			return fail("CONFLICT", `Incident is ${incident.status}, not open`);
		}
		if (kind === "resolve" && incident.status === "resolved") {
			return fail("CONFLICT", "Incident is already resolved");
		}
		const at = now();
		const event = kind === "acknowledge" ? "incident.acknowledged" : "incident.resolved";
		// Expect the status and assignee we read, so a concurrent change makes this one lose.
		const updated = await repository.update(
			principal.tenantId,
			id,
			{ status: incident.status, assigneeId: incident.assigneeId },
			kind === "acknowledge"
				? { status: "acknowledged", acknowledgedAt: at, acknowledgedBy: principal.userId }
				: { status: "resolved", resolvedAt: at, resolvedBy: principal.userId },
			auditEntry(
				auditOrigin(at, context),
				principal.tenantId,
				event,
				{ type: "user", id: principal.userId },
				{ type: "incident", id },
				{},
			),
			await noticeFor(principal, incident, event, at),
		);
		if (!updated) {
			return fail(
				"CONFLICT",
				kind === "acknowledge" ? "Incident is no longer open" : "Incident changed while resolving",
			);
		}
		await dispatcher.dispatch(principal.tenantId, id, event);
		return ok(await view(updated));
	};

	return {
		async create(principal, input, context) {
			const id = randomUUID() as IncidentId;
			const createdAt = now();
			const assignee = await onCall.assigneeFor(principal.tenantId, null, createdAt);
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
				assigneeId: assignee?.userId ?? null,
				assignmentCount: 0,
			};
			const entries = [
				auditEntry(
					auditOrigin(createdAt, context),
					principal.tenantId,
					"incident.created",
					{ type: "user", id: principal.userId },
					{ type: "incident", id },
					{ title: input.title, severity: input.severity },
				),
				...(assignee
					? [
							assignedEntry(principal, id, createdAt, context, {
								from: null,
								to: assignee.userId,
								manual: false,
							}),
						]
					: []),
			];
			const incident = await repository.create(
				principal.tenantId,
				opened,
				entries,
				await noticeFor(
					principal,
					{ ...opened, tenantId: principal.tenantId },
					"incident.opened",
					createdAt,
					assignee ? { email: assignee.email } : null,
				),
			);
			await dispatcher.dispatch(principal.tenantId, id, "incident.opened");
			return ok(await view(incident));
		},

		acknowledge: (principal, id, context) => transition(principal, id, context, "acknowledge"),

		resolve: (principal, id, context) => transition(principal, id, context, "resolve"),

		async assign(principal, id, assigneeId, context) {
			if (assigneeId === null && !isAdmin(principal)) {
				return fail("FORBIDDEN", "Only an admin can unassign an incident");
			}
			const incident = await repository.findById(principal.tenantId, id);
			if (!incident) return fail("NOT_FOUND", "Incident not found");
			if (incident.status === "resolved") {
				return fail("CONFLICT", "A resolved incident cannot be reassigned");
			}
			// Already theirs: nothing to record or post.
			if (incident.assigneeId === assigneeId) return ok(await view(incident));

			const memberNotFound: Result<never> = {
				ok: false,
				error: {
					code: "NOT_FOUND",
					detail: "Member not found",
					errors: [{ path: "assigneeId", message: "Member not found" }],
				},
			};
			const newAssignee = assigneeId
				? await members?.findUser(principal.tenantId, assigneeId)
				: null;
			if (assigneeId && !newAssignee) return memberNotFound;

			const at = now();
			const outcome = await repository.reassign(
				principal.tenantId,
				id,
				{ from: incident.assigneeId, to: assigneeId },
				assignedEntry(principal, id, at, context, {
					from: incident.assigneeId,
					to: assigneeId,
					manual: true,
				}),
				await noticeFor(
					principal,
					incident,
					"incident.reassigned",
					at,
					newAssignee ? { email: newAssignee.email } : null,
				),
			);
			if (outcome.status === "member_not_found") return memberNotFound;
			if (outcome.status === "changed") {
				return fail("CONFLICT", "Incident changed while reassigning");
			}
			await dispatcher.dispatch(principal.tenantId, id, "incident.reassigned");
			return ok(await view(outcome.incident));
		},

		async get(principal, id) {
			const incident = await repository.findById(principal.tenantId, id);
			return incident ? ok(await view(incident)) : fail("NOT_FOUND", "Incident not found");
		},

		async list(principal, page) {
			const { items, total } = await repository.list(principal.tenantId, page);
			return ok({ items: await views(principal.tenantId, items), total });
		},
	};
};
