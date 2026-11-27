import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { anAudit } from "../../../tests/auditEntries";
import type { IncidentId } from "../../contract/incidents";
import type { Incident } from "../../domain/incidents/types";
import type { TenantId } from "../../domain/shared/identity";
import type { SummaryPrompt, SummaryWriter, WriterResult } from "../../domain/summaries/types";
import { InMemoryAlertRepository } from "../../repository/alerts/inMemoryAlertRepository";
import { InMemoryChangeFeed } from "../../repository/events/inMemoryChangeFeed";
import { InMemoryIncidentRepository } from "../../repository/incidents/inMemoryIncidentRepository";
import { InMemorySummaryDraftRepository } from "../../repository/summaries/inMemorySummaryDraftRepository";
import { createSummaryProcessor, SUMMARY_LEASE_MS } from "./summaryProcessor";

// Spec: docs/features/ai-summaries.md, "The AI call".

const TENANT = "tenant-acme" as TenantId;
const START = new Date("2026-01-10T12:00:00Z");
const VALID = JSON.stringify({
	summary: "Checkout latency is high in every region.",
	suggestedSeverity: "sev1",
	rationale: "Customer-facing and widespread.",
});

class ScriptedWriter implements SummaryWriter {
	readonly prompts: SummaryPrompt[] = [];
	constructor(private readonly answers: WriterResult[]) {}
	async write(prompt: SummaryPrompt): Promise<WriterResult> {
		this.prompts.push(prompt);
		const answer = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
		if (!answer) throw new Error("no answer scripted");
		return answer;
	}
}

const ok = (content = VALID): WriterResult => ({
	kind: "ok",
	content,
	model: "qwen/qwen3-30b-a3b-instruct-2507",
	inputTokens: 1200,
	outputTokens: 80,
});

const setup = (writer: SummaryWriter | null) => {
	let clock = START.getTime();
	const now = () => new Date(clock);
	const feed = new InMemoryChangeFeed();
	const drafts = new InMemorySummaryDraftRepository(feed);
	const incidents = new InMemoryIncidentRepository(undefined, undefined, null, feed, drafts);
	const alerts = new InMemoryAlertRepository(incidents);
	const processor = createSummaryProcessor({ drafts, incidents, alerts, writer, now });
	const open = async () => {
		const incident: Omit<Incident, "tenantId"> = {
			id: randomUUID() as IncidentId,
			title: "Checkout is down",
			severity: "sev2",
			status: "open",
			createdAt: now(),
			createdBy: "user-1",
			acknowledgedAt: null,
			acknowledgedBy: null,
			resolvedAt: null,
			resolvedBy: null,
			alertSourceId: null,
			dedupKey: null,
			alertCount: 0,
			lastAlertAt: null,
			assigneeId: null,
			assignmentCount: 0,
			summary: null,
		};
		await incidents.create(TENANT, incident, [anAudit(TENANT)], undefined, {
			id: randomUUID(),
			incidentId: incident.id,
			requestedBy: null,
			createdAt: now(),
			dailyCap: 100,
		});
		const [draft] = (await drafts.list(TENANT, incident.id, { limit: 1, offset: 0 })).items;
		if (!draft) throw new Error("no draft queued");
		return draft;
	};
	const reload = async (id: string) => drafts.findById(TENANT, id);
	return {
		processor,
		open,
		reload,
		feed,
		drafts,
		advance: (ms: number) => {
			clock += ms;
		},
	};
};

describe("summary processor", () => {
	it("turns a pending draft into a ready one, recording the model and token counts", async () => {
		const writer = new ScriptedWriter([ok()]);
		const { processor, open, reload, feed } = setup(writer);
		const draft = await open();

		expect(await processor.process()).toBe(1);

		expect(await reload(draft.id)).toMatchObject({
			state: "ready",
			summary: "Checkout latency is high in every region.",
			suggestedSeverity: "sev1",
			rationale: "Customer-facing and widespread.",
			model: "qwen/qwen3-30b-a3b-instruct-2507",
			inputTokens: 1200,
			outputTokens: 80,
			attempts: 1,
			completedAt: START,
		});
		expect(writer.prompts[0]?.user).toContain("Checkout is down");
		expect(feed.published).toContainEqual({
			kind: "summary_draft",
			tenantId: TENANT,
			incidentId: draft.incidentId,
			id: draft.id,
		});
	});

	it.each([
		["not JSON", "The incident is bad."],
		["a missing field", JSON.stringify({ summary: "s", suggestedSeverity: "sev1" })],
		[
			"an unknown severity",
			JSON.stringify({ summary: "s", suggestedSeverity: "p0", rationale: "r" }),
		],
		[
			"a summary over 600 characters",
			JSON.stringify({ summary: "x".repeat(601), suggestedSeverity: "sev1", rationale: "r" }),
		],
		[
			"an extra field",
			JSON.stringify({
				summary: "s",
				suggestedSeverity: "sev1",
				rationale: "r",
				action: "resolve",
			}),
		],
	])("marks %s as invalid output, without retrying", async (_case, content) => {
		const { processor, open, reload } = setup(new ScriptedWriter([ok(content)]));
		const draft = await open();

		await processor.process();

		expect(await reload(draft.id)).toMatchObject({
			state: "failed",
			failureReason: "invalid_output",
			summary: null,
		});
	});

	it("retries a provider error after 10 s and 1 min, then gives up", async () => {
		const writer = new ScriptedWriter([{ kind: "retry", error: "HTTP 503" }]);
		const { processor, open, reload, advance } = setup(writer);
		const draft = await open();

		await processor.process();
		expect(await reload(draft.id)).toMatchObject({ state: "pending", attempts: 1 });
		advance(9_999);
		expect(await processor.process()).toBe(0);
		advance(1);
		await processor.process();
		expect(await reload(draft.id)).toMatchObject({ state: "pending", attempts: 2 });
		advance(60_000);
		await processor.process();

		expect(await reload(draft.id)).toMatchObject({
			state: "failed",
			failureReason: "provider_error",
			attempts: 3,
			lastError: "HTTP 503",
		});
		expect(writer.prompts).toHaveLength(3);
	});

	it("succeeds on a retry", async () => {
		const { processor, open, reload, advance } = setup(
			new ScriptedWriter([{ kind: "retry", error: "timeout" }, ok()]),
		);
		const draft = await open();

		await processor.process();
		advance(10_000);
		await processor.process();

		expect(await reload(draft.id)).toMatchObject({ state: "ready", attempts: 2 });
	});

	it("fails at once on an error that will not go away", async () => {
		const { processor, open, reload } = setup(
			new ScriptedWriter([{ kind: "fail", reason: "provider_error", error: "HTTP 401" }]),
		);
		const draft = await open();

		await processor.process();

		expect(await reload(draft.id)).toMatchObject({
			state: "failed",
			failureReason: "provider_error",
			attempts: 1,
		});
	});

	it("skips every draft as ai_disabled when no model is configured", async () => {
		const { processor, open, reload } = setup(null);
		const draft = await open();

		await processor.process();

		expect(await reload(draft.id)).toMatchObject({
			state: "skipped",
			failureReason: "ai_disabled",
		});
	});

	it("gives up on a draft whose attempts kept crashing before they finished", async () => {
		const writer = new ScriptedWriter([ok()]);
		const { processor, open, reload, advance, drafts } = setup(writer);
		const draft = await open();
		// Three workers claim it and die mid-call: each lease runs out with nothing recorded.
		for (let n = 0; n < 3; n++) {
			await drafts.claim(
				new Date(START.getTime() + n * SUMMARY_LEASE_MS),
				new Date(START.getTime() + (n + 1) * SUMMARY_LEASE_MS),
				5,
			);
		}
		advance(3 * SUMMARY_LEASE_MS);

		await processor.process();

		expect(await reload(draft.id)).toMatchObject({
			state: "failed",
			failureReason: "provider_error",
			attempts: 4,
			lastError: "attempts did not finish",
		});
		// No fourth call to the model.
		expect(writer.prompts).toHaveLength(0);
	});
});
