import type { OnCallAssigner, OnCallRepository } from "../../domain/onCall/types";
import { whoIsOnCall } from "../../domain/onCall/whoIsOnCall";

// Spec: docs/features/on-call-schedules.md, "Which schedule assigns an incident".

// Overrides never overlap, so the one covering `at` and the next one after it are enough to
// answer who is on call and until when.
export const OVERRIDES_NEEDED = 2;

export const createOnCallAssigner = (schedules: OnCallRepository): OnCallAssigner => ({
	async assigneeFor(tenantId, scheduleId, at) {
		// A linked schedule decides on its own: nobody on call there leaves the incident
		// unassigned, rather than falling back to the default.
		const schedule = scheduleId
			? await schedules.findById(tenantId, scheduleId)
			: await schedules.findDefault(tenantId);
		if (!schedule) return null;
		const overrides = await schedules.overridesFrom(tenantId, schedule.id, at, OVERRIDES_NEEDED);
		const shift = whoIsOnCall(schedule, overrides, at);
		return shift ? { userId: shift.userId, email: shift.email } : null;
	},
});

// For callers with no schedules, such as unit tests: every incident opens unassigned.
export const NO_ASSIGNER: OnCallAssigner = { assigneeFor: async () => null };
