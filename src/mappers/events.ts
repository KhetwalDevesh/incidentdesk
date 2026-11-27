import type { StreamEventName } from "../contract/events";
import type { StreamEvent } from "../domain/events/types";
import { toDashboardResponse } from "./dashboard";
import { toIncidentResponse } from "./incidents";
import { toOnCallOverrideResponse, toOnCallScheduleResponse } from "./onCall";
import { toSummaryDraftResponse } from "./summaries";

// The allowlist of what leaves the API on a stream: every resource through its own mapper.
export const toStreamMessage = (event: StreamEvent): { name: StreamEventName; data: unknown } => {
	switch (event.type) {
		case "ready":
		case "resync":
			return { name: event.type, data: {} };
		case "incident.opened":
		case "incident.acknowledged":
		case "incident.resolved":
		case "incident.reassigned":
		case "incident.updated":
			return { name: event.type, data: { incident: toIncidentResponse(event.incident) } };
		case "summary_draft.ready":
			return {
				name: event.type,
				data: { incidentId: event.incidentId, draft: toSummaryDraftResponse(event.draft) },
			};
		case "dashboard":
			return { name: "dashboard", data: toDashboardResponse(event.dashboard) };
		case "on_call_schedule.created":
		case "on_call_schedule.updated":
			return { name: event.type, data: { schedule: toOnCallScheduleResponse(event.schedule) } };
		case "on_call_schedule.deleted":
			return { name: event.type, data: { id: event.id } };
		case "on_call_override.created":
			return {
				name: event.type,
				data: { scheduleId: event.scheduleId, override: toOnCallOverrideResponse(event.override) },
			};
		case "on_call_override.deleted":
			return { name: event.type, data: { scheduleId: event.scheduleId, id: event.id } };
	}
};
