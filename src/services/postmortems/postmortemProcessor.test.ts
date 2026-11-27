import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { anAudit } from "../../../tests/auditEntries";
import type { IncidentId } from "../../contract/incidents";
import type { Incident } from "../../domain/incidents/types";
import type { TenantId } from "../../domain/shared/identity";
import type { SummaryPrompt, SummaryWriter, WriterResult } from "../../domain/summaries/types";
import { InMemoryAlertRepository } from "../../repository/alerts/inMemoryAlertRepository";
import { InMemoryAuditStore } from "../../repository/audit/inMemoryAuditStore";
import { InMemoryChangeFeed } from "../../repository/events/inMemoryChangeFeed";
import { InMemoryIncidentRepository } from "../../repository/incidents/inMemoryIncidentRepository";
import { InMemorySummaryDraftRepository } from "../../repository/summaries/inMemorySummaryDraftRepository";
import { createPostmortemProcessor } from "./postmortemProcessor";

// Spec: docs/features/ai-postmortems.md

const TENANT = "tenant-acme" as TenantId;
const START = new Date("2026-01-10T12:00:00Z");
const CONTENT = {
	summary: "Checkout was slow for 20 minutes.",
	impact: "Customers in the EU.",
	timeline: [
		{ at: "2026-01-10T11:40:00Z", event: "Opened" },
		{ at: "2026-01-10T12:00:00Z", event: "Resolved" },
	],
	suspectedCause: "The data suggests a slow dependency.",
	wentWell: ["Quick acknowledgement"],
	wentWrong: [],
	actionItems: ["Add a latency alert"],
};

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

const ok = (content: unknown = CONTENT): WriterResult => ({
	kind: "ok",
	content: JSON.stringify(content),
	model: "qwen/qwen3-30b-a3b-instruct-2507",
	inputTokens: 3000,
	outputTokens: 600,
});

const setup = (writer: SummaryWriter | null) => {
	let clock = START.getTime();
	const now = () => new Date(clock);
	const feed = new InMemoryChangeFeed();
	const audit = new InMemoryAuditStore();
	const incidents = new InMemoryIncidentRepository(
		audit,
		undefined,
		null,
		feed,
		new InMemorySummaryDraftRepository(feed),
	);
	const drafts = incidents.postmortemDrafts;
	const processor = createPostmortemProcessor({
		drafts,
		incidents,
		alerts: new InMemoryAlertRepository(incidents),
		audit,
		writer,
		now,
	});
	// Opens and resolves an incident, which queues a postmortem draft in the resolving change.
	const resolved = async () => {
		const incident: Omit<Incident, "tenantId"> = {
			id: randomUUID() as IncidentId,
			title: "Checkout is down",
			severity: "sev1",
			status: "open",
			createdAt: new Date(START.getTime() - 20 * 60_000),
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
		await incidents.create(TENANT, incident, [
			anAudit(TENANT, "incident.created", { resource: { type: "incident", id: incident.id } }),
		]);
		await incidents.update(
			TENANT,
			incident.id,
			{ status: "open", assigneeId: null },
			{ status: "resolved", resolvedAt: now(), resolvedBy: "user-1" },
			anAudit(TENANT, "incident.resolved", { resource: { type: "incident", id: incident.id } }),
			undefined,
			{
				id: randomUUID(),
				incidentId: incident.id,
				requestedBy: null,
				createdAt: now(),
				dailyCap: 100,
			},
		);
		const [draft] = (await drafts.list(TENANT, incident.id, { limit: 1, offset: 0 })).items;
		if (!draft) throw new Error("no draft queued");
		return draft;
	};
	return {
		processor,
		resolved,
		reload: (id: string) => drafts.findById(TENANT, id),
		advance: (ms: number) => {
			clock += ms;
		},
	};
};

describe("postmortem processor", () => {
	it("drafts a postmortem from the incident and its timeline, labelled with the model", async () => {
		const writer = new ScriptedWriter([ok()]);
		const { processor, resolved, reload } = setup(writer);
		const draft = await resolved();

		expect(await processor.process()).toBe(1);

		expect(await reload(draft.id)).toMatchObject({
			state: "ready",
			content: CONTENT,
			model: "qwen/qwen3-30b-a3b-instruct-2507",
			inputTokens: 3000,
			outputTokens: 600,
		});
		const user = writer.prompts[0]?.user ?? "";
		expect(user).toContain('"action": "opened"');
		expect(user).toContain('"action": "resolved"');
		expect(writer.prompts[0]?.maxOutputTokens).toBe(8000);
	});

	it.each([
		["a missing section", { ...CONTENT, impact: undefined }],
		["an unparseable time", { ...CONTENT, timeline: [{ at: "yesterday", event: "Opened" }] }],
		["an empty timeline", { ...CONTENT, timeline: [] }],
		["too many action items", { ...CONTENT, actionItems: Array.from({ length: 11 }, () => "x") }],
		["an extra field", { ...CONTENT, close: true }],
	])("marks %s as invalid output", async (_case, content) => {
		const { processor, resolved, reload } = setup(new ScriptedWriter([ok(content)]));
		const draft = await resolved();

		await processor.process();

		expect(await reload(draft.id)).toMatchObject({
			state: "failed",
			failureReason: "invalid_output",
			content: null,
		});
	});

	it("retries a provider error, then gives up after three attempts", async () => {
		const writer = new ScriptedWriter([{ kind: "retry", error: "HTTP 429" }]);
		const { processor, resolved, reload, advance } = setup(writer);
		const draft = await resolved();

		await processor.process();
		advance(10_000);
		await processor.process();
		advance(60_000);
		await processor.process();

		expect(await reload(draft.id)).toMatchObject({
			state: "failed",
			failureReason: "provider_error",
			attempts: 3,
		});
		expect(writer.prompts).toHaveLength(3);
	});

	it("skips every draft as ai_disabled when no model is configured", async () => {
		const { processor, resolved, reload } = setup(null);
		const draft = await resolved();

		await processor.process();

		expect(await reload(draft.id)).toMatchObject({
			state: "skipped",
			failureReason: "ai_disabled",
		});
	});
});
