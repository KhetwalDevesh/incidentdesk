import { randomUUID } from "node:crypto";
import { auditEntry, auditOrigin } from "../../domain/audit/types";
import type {
	OnCallRepository,
	OnCallScheduleService,
	ScheduleFields,
	ScheduleWriteOutcome,
} from "../../domain/onCall/types";
import { whoIsOnCall } from "../../domain/onCall/whoIsOnCall";
import { isAdmin, type Principal } from "../../domain/shared/identity";
import { type AppError, fail, ok, type Result } from "../../domain/shared/result";
import { OVERRIDES_NEEDED } from "./onCallAssigner";

// Spec: docs/features/on-call-schedules.md

const SCHEDULE_NOT_FOUND = "On-call schedule not found";

const withPaths = (error: AppError, paths: string[], message: string): Result<never> => ({
	ok: false,
	error: { ...error, errors: paths.map((path) => ({ path, message })) },
});

// Turns a refused schedule write into the problem the API returns.
const refused = (outcome: Exclude<ScheduleWriteOutcome, { status: "saved" }>): Result<never> => {
	switch (outcome.status) {
		case "not_found":
			return fail("NOT_FOUND", SCHEDULE_NOT_FOUND);
		case "name_taken":
			return fail("CONFLICT", "The tenant already has a schedule with this name");
		case "members_not_found":
			return withPaths(
				{ code: "NOT_FOUND", detail: "Member not found" },
				outcome.indexes.map((index) => `participants.${index}`),
				"Member not found",
			);
	}
};

const forbidden = () => fail("FORBIDDEN", "Only admins can manage on-call schedules");

export const createOnCallScheduleService = (
	schedules: OnCallRepository,
	now: () => Date = () => new Date(),
): OnCallScheduleService => {
	const actor = (principal: Principal) => ({ type: "user", id: principal.userId }) as const;

	return {
		async create(principal, input, context) {
			if (!isAdmin(principal)) return forbidden();
			const id = randomUUID();
			const createdAt = now();
			const { participants, ...fields } = input;
			const outcome = await schedules.create(
				principal.tenantId,
				{ ...fields, id, participantIds: participants, createdAt },
				auditEntry(
					auditOrigin(createdAt, context),
					principal.tenantId,
					"on_call_schedule.created",
					actor(principal),
					{ type: "on_call_schedule", id },
					{ name: input.name },
				),
			);
			return outcome.status === "saved" ? ok(outcome.schedule) : refused(outcome);
		},

		async list(principal, page) {
			return ok(await schedules.list(principal.tenantId, page));
		},

		async get(principal, id) {
			const schedule = await schedules.findById(principal.tenantId, id);
			return schedule ? ok(schedule) : fail("NOT_FOUND", SCHEDULE_NOT_FOUND);
		},

		async update(principal, id, input, context) {
			if (!isAdmin(principal)) return forbidden();
			const { participants, ...fields } = input;
			const patch: Partial<Omit<ScheduleFields, "id">> = {
				...fields,
				...(participants ? { participantIds: participants } : {}),
			};
			const at = now();
			const outcome = await schedules.update(principal.tenantId, id, patch, (before) =>
				auditEntry(
					auditOrigin(at, context),
					principal.tenantId,
					"on_call_schedule.updated",
					actor(principal),
					{ type: "on_call_schedule", id },
					{ name: input.name ?? before.name, changed: Object.keys(input).sort().join(",") },
				),
			);
			return outcome.status === "saved" ? ok(outcome.schedule) : refused(outcome);
		},

		async delete(principal, id, context) {
			if (!isAdmin(principal)) return forbidden();
			const at = now();
			const deleted = await schedules.delete(principal.tenantId, id, (schedule) =>
				auditEntry(
					auditOrigin(at, context),
					principal.tenantId,
					"on_call_schedule.deleted",
					actor(principal),
					{ type: "on_call_schedule", id },
					{ name: schedule.name },
				),
			);
			return deleted ? ok(undefined) : fail("NOT_FOUND", SCHEDULE_NOT_FOUND);
		},

		async onCall(principal, id, requested) {
			const schedule = await schedules.findById(principal.tenantId, id);
			if (!schedule) return fail("NOT_FOUND", SCHEDULE_NOT_FOUND);
			const at = requested ?? now();
			const overrides = await schedules.overridesFrom(principal.tenantId, id, at, OVERRIDES_NEEDED);
			return ok({ at, onCall: whoIsOnCall(schedule, overrides, at) });
		},

		async addOverride(principal, scheduleId, input, context) {
			const schedule = await schedules.findById(principal.tenantId, scheduleId);
			if (!schedule) return fail("NOT_FOUND", SCHEDULE_NOT_FOUND);
			if (!isAdmin(principal) && input.userId !== principal.userId) {
				return fail("FORBIDDEN", "Only admins can add an override for someone else");
			}
			const createdAt = now();
			const startsAt = new Date(input.startsAt);
			const endsAt = new Date(input.endsAt);
			if (endsAt <= createdAt) {
				return withPaths(
					{ code: "VALIDATION_FAILED", detail: "The request is invalid" },
					["endsAt"],
					"Must be in the future",
				);
			}
			const id = randomUUID();
			const outcome = await schedules.addOverride(
				principal.tenantId,
				{
					id,
					scheduleId,
					userId: input.userId,
					startsAt,
					endsAt,
					createdBy: principal.userId,
					createdAt,
				},
				auditEntry(
					auditOrigin(createdAt, context),
					principal.tenantId,
					"on_call_override.created",
					actor(principal),
					{ type: "on_call_schedule", id: scheduleId },
					{
						overrideId: id,
						userId: input.userId,
						startsAt: startsAt.toISOString(),
						endsAt: endsAt.toISOString(),
					},
				),
			);
			switch (outcome.status) {
				case "added":
					return ok(outcome.override);
				case "schedule_not_found":
					return fail("NOT_FOUND", SCHEDULE_NOT_FOUND);
				case "member_not_found":
					return withPaths(
						{ code: "NOT_FOUND", detail: "Member not found" },
						["userId"],
						"Member not found",
					);
				case "overlaps":
					return fail("CONFLICT", "The override overlaps another override in this schedule");
			}
		},

		async listOverrides(principal, scheduleId, { from, limit, offset }) {
			const schedule = await schedules.findById(principal.tenantId, scheduleId);
			if (!schedule) return fail("NOT_FOUND", SCHEDULE_NOT_FOUND);
			return ok(
				await schedules.listOverrides(
					principal.tenantId,
					scheduleId,
					from ? new Date(from) : now(),
					{ limit, offset },
				),
			);
		},

		async deleteOverride(principal, scheduleId, overrideId, context) {
			const override = await schedules.findOverride(principal.tenantId, scheduleId, overrideId);
			if (!override) return fail("NOT_FOUND", "Override not found");
			if (!isAdmin(principal) && override.userId !== principal.userId) {
				return fail("FORBIDDEN", "Only admins can remove someone else's override");
			}
			const deleted = await schedules.deleteOverride(
				principal.tenantId,
				scheduleId,
				overrideId,
				auditEntry(
					auditOrigin(now(), context),
					principal.tenantId,
					"on_call_override.deleted",
					actor(principal),
					{ type: "on_call_schedule", id: scheduleId },
					{
						overrideId,
						userId: override.userId,
						startsAt: override.startsAt.toISOString(),
						endsAt: override.endsAt.toISOString(),
					},
				),
			);
			return deleted ? ok(undefined) : fail("NOT_FOUND", "Override not found");
		},
	};
};
