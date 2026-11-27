import { DraftOutputSchema } from "../../contract/summaries";
import type { AlertRepository } from "../../domain/alerts/types";
import type { IncidentRepository } from "../../domain/incidents/types";
import type {
	SummaryDraft,
	SummaryDraftRepository,
	SummaryProcessor,
	SummaryWriter,
} from "../../domain/summaries/types";
import { buildPrompt, MAX_PROMPT_ALERTS } from "./prompt";

// Spec: docs/features/ai-summaries.md, "The AI call" and "How it runs".

// At most this many attempts per draft. Retries wait these delays after attempts 1 and 2.
export const SUMMARY_MAX_ATTEMPTS = 3;
export const SUMMARY_RETRY_DELAYS_MS = [10_000, 60_000] as const;
// Longer than any call's timeout (60 s for summaries, 100 s for postmortems), so a live
// attempt is never claimed twice.
export const SUMMARY_LEASE_MS = 120_000;

export type SummaryProcessorDeps = {
	drafts: SummaryDraftRepository;
	incidents: Pick<IncidentRepository, "findById">;
	alerts: Pick<AlertRepository, "listForIncident">;
	// Null when no AI is configured: every draft is skipped as ai_disabled.
	writer: SummaryWriter | null;
	now?: () => Date;
	batchSize?: number;
	// Gets a draft id and a fixed description, never a prompt or model output.
	onError?: (subject: string, error: unknown) => void;
};

// The model's text as JSON, or undefined. Still untrusted: the caller validates it.
export const parseModelJson = (content: string): unknown => {
	try {
		return JSON.parse(content);
	} catch {
		return undefined;
	}
};

export const createSummaryProcessor = ({
	drafts,
	incidents,
	alerts,
	writer,
	now = () => new Date(),
	batchSize = 5,
	onError = () => undefined,
}: SummaryProcessorDeps): SummaryProcessor => {
	const fail = (draft: SummaryDraft, reason: "provider_error" | "invalid_output", error: string) =>
		drafts.complete(
			draft.tenantId,
			draft.id,
			{ state: "failed", failureReason: reason, error },
			now(),
		);

	const work = async (draft: SummaryDraft) => {
		if (!writer) {
			await drafts.complete(
				draft.tenantId,
				draft.id,
				{ state: "skipped", failureReason: "ai_disabled", error: null },
				now(),
			);
			return;
		}
		// Earlier attempts started but never recorded an outcome: the worker crashed each time.
		if (draft.attempts > SUMMARY_MAX_ATTEMPTS) {
			await fail(draft, "provider_error", "attempts did not finish");
			return;
		}
		// Tenant-scoped reads, with the draft's own tenant: never another tenant's data.
		const incident = await incidents.findById(draft.tenantId, draft.incidentId);
		if (!incident) {
			await fail(draft, "provider_error", "incident not found");
			return;
		}
		const recent = await alerts.listForIncident(
			draft.tenantId,
			draft.incidentId,
			MAX_PROMPT_ALERTS,
		);
		const result = await writer.write(buildPrompt(incident, recent));

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
		// The model's answer is untrusted until it passes the schema, length limits included.
		const output = DraftOutputSchema.safeParse(parseModelJson(result.content));
		if (!output.success) {
			await fail(draft, "invalid_output", "output did not match the schema");
			return;
		}
		await drafts.complete(
			draft.tenantId,
			draft.id,
			{
				state: "ready",
				...output.data,
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
					// A database error. The lease ends, the draft comes back, and this attempt counts.
					onError(`summary draft ${draft.id}`, error);
				}
			}
			return claimed.length;
		},
	};
};
