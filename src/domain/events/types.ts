import type { Dashboard } from "../dashboard/types";
import type { IncidentChanges, IncidentView } from "../incidents/types";
import type { OnCallOverride, OnCallSchedule } from "../onCall/types";
import type { Principal, TenantId } from "../shared/identity";
import type { SummaryDraft } from "../summaries/types";

// Spec: docs/features/realtime-status.md

export type IncidentChange =
	| "incident.opened"
	| "incident.acknowledged"
	| "incident.resolved"
	| "incident.reassigned"
	// Its summary or severity changed. Spec: docs/features/ai-summaries.md.
	| "incident.updated";

// The realtime event an incident update makes, if any.
export const transitionEvent = (changes: IncidentChanges): IncidentChange | null =>
	changes.status === "acknowledged"
		? "incident.acknowledged"
		: changes.status === "resolved"
			? "incident.resolved"
			: null;

// What changed, published inside the change's own transaction so it is seen only when the
// change commits. Ids only: never titles, emails or any other content.
export type ChangeNotice =
	| { kind: "incident"; tenantId: TenantId; id: string; event: IncidentChange }
	| {
			kind: "on_call_schedule";
			tenantId: TenantId;
			id: string;
			event: "on_call_schedule.created" | "on_call_schedule.updated" | "on_call_schedule.deleted";
	  }
	| {
			kind: "on_call_override";
			tenantId: TenantId;
			scheduleId: string;
			id: string;
			event: "on_call_override.created" | "on_call_override.deleted";
	  }
	// The members' streams close, and the tenant resyncs: their incidents were unassigned.
	| { kind: "members_removed"; tenantId: TenantId; userIds: string[] }
	// A draft finished: ready, failed or skipped. Spec: docs/features/ai-summaries.md.
	| { kind: "summary_draft"; tenantId: TenantId; incidentId: string; id: string };

// What the feed hands the hub: a notice, or a warning that notices may have been missed.
export type FeedItem = ChangeNotice | { kind: "resync" };

// Every committed notice, from every process. Returns an unsubscribe function.
export interface ChangeFeed {
	subscribe(listener: (item: FeedItem) => void): () => void;
}

// One event on a stream, with domain objects. The route maps each through the API's mappers.
export type StreamEvent =
	| { type: "ready" }
	| { type: "resync" }
	| { type: IncidentChange; incident: IncidentView }
	| { type: "dashboard"; dashboard: Dashboard }
	| {
			type: "on_call_schedule.created" | "on_call_schedule.updated";
			schedule: OnCallSchedule;
	  }
	| { type: "on_call_schedule.deleted"; id: string }
	| { type: "on_call_override.created"; scheduleId: string; override: OnCallOverride }
	| { type: "on_call_override.deleted"; scheduleId: string; id: string }
	| { type: "summary_draft.ready"; incidentId: string; draft: SummaryDraft };

// Where one stream's events go. `write` resolves once the event is sent; `close` ends the
// stream for good.
export type StreamSink = {
	write(event: StreamEvent): Promise<void>;
	close(): void;
};

export interface EventHub {
	// Opens a stream for the principal. Returns a function that closes it.
	connect(principal: Principal, sink: StreamSink): () => void;
	// Closes every stream and stops listening, for shutdown.
	shutdown(): void;
}
