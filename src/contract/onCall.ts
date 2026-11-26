import { z } from "zod";
import { PageQuerySchema } from "./common";
import { uniqueIds } from "./members";

// Spec: docs/features/on-call-schedules.md

export const MAX_SCHEDULE_PARTICIPANTS = 50;
export const MAX_OVERRIDE_DAYS = 90;
export const MAX_OVERRIDE_MS = MAX_OVERRIDE_DAYS * 24 * 60 * 60 * 1000;
export const ON_CALL_SOURCES = ["rotation", "override"] as const;

export const OnCallScheduleIdSchema = z.uuid();
export const OnCallOverrideIdSchema = z.uuid();

// A zone name Node's Intl knows, such as Europe/London or UTC. Fixed offsets are refused.
const isTimeZone = (value: string) => {
	if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
};

const TimeZoneSchema = z
	.string()
	.max(64)
	.refine(isTimeZone, "Must be an IANA time zone, such as Europe/London");

// 00:00 to 23:59. 24:00 is refused.
const HandoffTimeSchema = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Must be a time from 00:00 to 23:59");

// A real calendar date: 2026-02-30 is refused.
const DateSchema = z.iso
	.date()
	.refine(
		(value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
		"Must be a real date",
	);

const ParticipantsSchema = z
	.array(z.uuid())
	.max(MAX_SCHEDULE_PARTICIPANTS)
	.superRefine(
		uniqueIds(
			(id) => id,
			(index) => [index],
		),
	);

const scheduleFields = {
	name: z.string().trim().min(1).max(100),
	timeZone: TimeZoneSchema,
	handoffTime: HandoffTimeSchema,
	rotationDays: z.number().int().min(1).max(28),
	startsOn: DateSchema,
	// Member ids in rotation order.
	participants: ParticipantsSchema,
	isDefault: z.boolean(),
};

export const CreateOnCallScheduleRequestSchema = z
	.strictObject({
		...scheduleFields,
		participants: scheduleFields.participants.default([]),
		isDefault: scheduleFields.isDefault.default(false),
	})
	.openapi("CreateOnCallScheduleRequest");

export type CreateOnCallScheduleRequest = z.infer<typeof CreateOnCallScheduleRequestSchema>;

export const UpdateOnCallScheduleRequestSchema = z
	.strictObject({
		name: scheduleFields.name.optional(),
		timeZone: scheduleFields.timeZone.optional(),
		handoffTime: scheduleFields.handoffTime.optional(),
		rotationDays: scheduleFields.rotationDays.optional(),
		startsOn: scheduleFields.startsOn.optional(),
		participants: scheduleFields.participants.optional(),
		isDefault: scheduleFields.isDefault.optional(),
	})
	.refine((patch) => Object.keys(patch).length > 0, "Change at least one field")
	.openapi("UpdateOnCallScheduleRequest", {
		description: "Any subset. A participants list replaces the whole rotation.",
	});

export type UpdateOnCallScheduleRequest = z.infer<typeof UpdateOnCallScheduleRequestSchema>;

const MemberRefSchema = z.strictObject({ userId: z.uuid(), email: z.string() });

// Strict so a leaked internal field, such as tenantId, fails the contract test.
export const OnCallScheduleSchema = z
	.strictObject({
		id: z.uuid(),
		name: z.string(),
		timeZone: z.string(),
		handoffTime: z.string(),
		rotationDays: z.number().int(),
		startsOn: z.string(),
		isDefault: z.boolean(),
		participants: z.array(MemberRefSchema),
		createdAt: z.iso.datetime(),
	})
	.openapi("OnCallSchedule");

export type OnCallScheduleResponse = z.infer<typeof OnCallScheduleSchema>;

export const OnCallScheduleListSchema = z
	.strictObject({
		items: z.array(OnCallScheduleSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("OnCallScheduleList");

export const OnCallQuerySchema = z.object({
	// Defaults to now.
	at: z.iso.datetime({ offset: true }).optional(),
});

export const OnCallSchema = z
	.strictObject({
		at: z.iso.datetime(),
		onCall: z
			.strictObject({
				userId: z.uuid(),
				email: z.string(),
				source: z.enum(ON_CALL_SOURCES),
				from: z.iso.datetime(),
				// The next handover, the end of the override, or the start of the next override.
				until: z.iso.datetime(),
			})
			.nullable(),
	})
	.openapi("OnCall", { description: "Who is on call at a time. Null when nobody is." });

export type OnCallResponse = z.infer<typeof OnCallSchema>;

export const CreateOnCallOverrideRequestSchema = z
	.strictObject({
		userId: z.uuid(),
		startsAt: z.iso.datetime({ offset: true }),
		endsAt: z.iso.datetime({ offset: true }),
	})
	.superRefine(({ startsAt, endsAt }, ctx) => {
		const length = Date.parse(endsAt) - Date.parse(startsAt);
		if (length <= 0) {
			ctx.addIssue({ code: "custom", path: ["endsAt"], message: "Must be after startsAt" });
		} else if (length > MAX_OVERRIDE_MS) {
			ctx.addIssue({
				code: "custom",
				path: ["endsAt"],
				message: `An override lasts at most ${MAX_OVERRIDE_DAYS} days`,
			});
		}
	})
	.openapi("CreateOnCallOverrideRequest");

export type CreateOnCallOverrideRequest = z.infer<typeof CreateOnCallOverrideRequestSchema>;

export const OnCallOverrideSchema = z
	.strictObject({
		id: z.uuid(),
		userId: z.uuid(),
		email: z.string(),
		startsAt: z.iso.datetime(),
		endsAt: z.iso.datetime(),
		createdBy: z.uuid(),
		createdAt: z.iso.datetime(),
	})
	.openapi("OnCallOverride");

export type OnCallOverrideResponse = z.infer<typeof OnCallOverrideSchema>;

export const OnCallOverrideListQuerySchema = PageQuerySchema.extend({
	// Lists overrides ending after this. Defaults to now.
	from: z.iso.datetime({ offset: true }).optional(),
});

export type OnCallOverrideListQuery = z.infer<typeof OnCallOverrideListQuerySchema>;

export const OnCallOverrideListSchema = z
	.strictObject({
		items: z.array(OnCallOverrideSchema),
		total: z.number().int(),
		limit: z.number().int(),
		offset: z.number().int(),
	})
	.openapi("OnCallOverrideList");
