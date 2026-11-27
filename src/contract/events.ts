import { z } from "zod";
import { DashboardSchema } from "./dashboard";
import { IncidentSchema } from "./incidents";
import { OnCallOverrideSchema, OnCallScheduleSchema } from "./onCall";

// Spec: docs/features/realtime-status.md. The data of each Server-Sent Event, by event name.
// OpenAPI cannot describe a stream's events, so these are checked by the contract tests.

export const EmptyEventSchema = z.strictObject({});

export const IncidentEventSchema = z.strictObject({ incident: IncidentSchema });

export const ScheduleEventSchema = z.strictObject({ schedule: OnCallScheduleSchema });

export const ScheduleDeletedEventSchema = z.strictObject({ id: z.uuid() });

export const OverrideCreatedEventSchema = z.strictObject({
	scheduleId: z.uuid(),
	override: OnCallOverrideSchema,
});

export const OverrideDeletedEventSchema = z.strictObject({ scheduleId: z.uuid(), id: z.uuid() });

export const STREAM_EVENT_SCHEMAS = {
	ready: EmptyEventSchema,
	resync: EmptyEventSchema,
	"incident.opened": IncidentEventSchema,
	"incident.acknowledged": IncidentEventSchema,
	"incident.resolved": IncidentEventSchema,
	"incident.reassigned": IncidentEventSchema,
	dashboard: DashboardSchema,
	"on_call_schedule.created": ScheduleEventSchema,
	"on_call_schedule.updated": ScheduleEventSchema,
	"on_call_schedule.deleted": ScheduleDeletedEventSchema,
	"on_call_override.created": OverrideCreatedEventSchema,
	"on_call_override.deleted": OverrideDeletedEventSchema,
} as const;

export type StreamEventName = keyof typeof STREAM_EVENT_SCHEMAS;

// Clients wait this long before reconnecting.
export const STREAM_RETRY_MS = 3000;
