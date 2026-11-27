import { PostmortemContentSchema } from "../../contract/postmortems";
import type { AlertRepository } from "../../domain/alerts/types";
import type { AuditEntry, AuditEventReader } from "../../domain/audit/types";
import type { IncidentRepository } from "../../domain/incidents/types";
import type {
	PostmortemDraft,
	PostmortemDraftRepository,
	PostmortemProcessor,
} from "../../domain/postmortems/types";
import type { TenantId } from "../../domain/shared/identity";
import type { SummaryWriter } from "../../domain/summaries/types";
import {
	parseModelJson,
	SUMMARY_LEASE_MS,
	SUMMARY_MAX_ATTEMPTS,
	SUMMARY_RETRY_DELAYS_MS,
} from "../summaries/summaryProcessor";
import { buildPostmortemPrompt, MAX_PROMPT_ALERTS, reduceTimeline } from "./postmortemPrompt";

// Spec: docs/features/ai-postmortems.md. The same attempts, retries and validation as summary
// drafts, with a postmortem prompt and schema.

// The audit timeline is read in pages, up to this many entries: enough for a long incident
// once runs of grouped alerts collapse.
const AUDIT_PAGE = 100;
const MAX_AUDIT_PAGES = 5;

export type PostmortemProcessorDeps = {
	drafts: PostmortemDraftRepository;
	incidents: Pick<IncidentRepository, "findById">;
	alerts: Pick<AlertRepository, "listForIncident">;
	audit: Pick<AuditEventReader, "listForResource">;
	writer: SummaryWriter | null;
	now?: () => Date;
	batchSize?: number;
	onError?: (subject: string, error: unknown) => void;
};

export const createPostmortemProcessor = ({
	drafts,
	incidents,
	alerts,
	audit,
	writer,
	now = () => new Date(),
	batchSize = 3,
	onError = () => undefined,
}: PostmortemProcessorDeps): PostmortemProcessor => {
	const fail = (
		draft: PostmortemDraft,
		reason: "provider_error" | "invalid_output",
		error: string,
	) =>
		drafts.complete(
			draft.tenantId,
			draft.id,
			{ state: "failed", failureReason: reason, error },
			now(),
		);

	// Oldest first, tenant-scoped with the draft's own tenant.
	const timelineOf = async (tenantId: TenantId, incidentId: string) => {
		const entries: AuditEntry[] = [];
		for (let page = 0; page < MAX_AUDIT_PAGES; page++) {
			const { items } = await audit.listForResource(
				tenantId,
				{ type: "incident", id: incidentId },
				{ limit: AUDIT_PAGE, offset: page * AUDIT_PAGE },
			);
			entries.push(...items);
			if (items.length < AUDIT_PAGE) break;
		}
		return entries;
	};

	const work = async (draft: PostmortemDraft) => {
		if (!writer) {
			await drafts.complete(
				draft.tenantId,
				draft.id,
				{ state: "skipped", failureReason: "ai_disabled", error: null },
				now(),
			);
			return;
		}
		if (draft.attempts > SUMMARY_MAX_ATTEMPTS) {
			await fail(draft, "provider_error", "attempts did not finish");
			return;
		}
		const incident = await incidents.findById(draft.tenantId, draft.incidentId);
		if (!incident) {
			await fail(draft, "provider_error", "incident not found");
			return;
		}
		const [recent, entries] = await Promise.all([
			alerts.listForIncident(draft.tenantId, draft.incidentId, MAX_PROMPT_ALERTS),
			timelineOf(draft.tenantId, draft.incidentId),
		]);
		const result = await writer.write(
			buildPostmortemPrompt(incident, recent, reduceTimeline(entries)),
		);

		if (result.kind === "retry") {
			const delay = SUMMARY_RETRY_DELAYS_MS[draft.attempts - 1];
			if (delay === undefined) {
				await fail(draft, "provider_error", result.error);
				return;
			}
			await drafts.retry(draft.tenantId, draft.id, new Date(now().getTime() + delay), result.error);
			return;
		}
		if (result.kind === "fail") {
			await fail(draft, result.reason, result.error);
			return;
		}
		// The model's answer is untrusted until it passes the schema, limits included.
		const content = PostmortemContentSchema.safeParse(parseModelJson(result.content));
		if (!content.success) {
			await fail(draft, "invalid_output", "output did not match the schema");
			return;
		}
		await drafts.complete(
			draft.tenantId,
			draft.id,
			{
				state: "ready",
				content: content.data,
				model: result.model,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
			},
			now(),
		);
	};

	return {
		async process() {
			const at = now();
			const claimed = await drafts.claim(at, new Date(at.getTime() + SUMMARY_LEASE_MS), batchSize);
			for (const draft of claimed) {
				try {
					await work(draft);
				} catch (error) {
					onError(`postmortem draft ${draft.id}`, error);
				}
			}
			return claimed.length;
		},
	};
};
