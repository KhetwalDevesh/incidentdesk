import type {
	OnCallOverrideResponse,
	OnCallResponse,
	OnCallScheduleResponse,
} from "../contract/onCall";
import type { OnCallAt, OnCallOverride, OnCallSchedule } from "../domain/onCall/types";

// The allowlists of what leaves the API. tenantId never does.

export const toOnCallScheduleResponse = (schedule: OnCallSchedule): OnCallScheduleResponse => ({
	id: schedule.id,
	name: schedule.name,
	timeZone: schedule.timeZone,
	handoffTime: schedule.handoffTime,
	rotationDays: schedule.rotationDays,
	startsOn: schedule.startsOn,
	isDefault: schedule.isDefault,
	participants: schedule.participants.map(({ userId, email }) => ({ userId, email })),
	createdAt: schedule.createdAt.toISOString(),
});

export const toOnCallResponse = ({ at, onCall }: OnCallAt): OnCallResponse => ({
	at: at.toISOString(),
	onCall: onCall
		? {
				userId: onCall.userId,
				email: onCall.email,
				source: onCall.source,
				from: onCall.from.toISOString(),
				until: onCall.until.toISOString(),
			}
		: null,
});

export const toOnCallOverrideResponse = (override: OnCallOverride): OnCallOverrideResponse => ({
	id: override.id,
	userId: override.userId,
	email: override.email,
	startsAt: override.startsAt.toISOString(),
	endsAt: override.endsAt.toISOString(),
	createdBy: override.createdBy,
	createdAt: override.createdAt.toISOString(),
});
