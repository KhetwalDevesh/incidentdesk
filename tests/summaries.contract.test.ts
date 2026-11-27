import { beforeEach, describe, expect, it } from "vitest";
import { ProblemSchema } from "../src/contract/common";
import { IncidentSchema } from "../src/contract/incidents";
import { SummaryDraftListSchema, SummaryDraftSchema } from "../src/contract/summaries";
import { addAlertSource, buildTestSystem, signedAlert, signup } from "./helpers";

// Spec: docs/features/ai-summaries.md

describe("ai summaries contract", () => {
	let system: ReturnType<typeof buildTestSystem>;
	let admin: string;

	const send = (method: string, path: string, token: string, body?: unknown) =>
		system.app.request(path, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

	const openIncident = async (token = admin) =>
		IncidentSchema.parse(
			await (
				await send("POST", "/v1/incidents", token, { title: "Checkout is down", severity: "sev2" })
			).json(),
		);

	const drafts = async (incidentId: string, token = admin) => {
		const res = await send("GET", `/v1/incidents/${incidentId}/summary-drafts`, token);
		expect(res.status).toBe(200);
		return SummaryDraftListSchema.parse(await res.json());
	};

	const problem = async (res: Response, status: number) => {
		expect(res.status).toBe(status);
		return ProblemSchema.parse(await res.json());
	};

	beforeEach(async () => {
		system = buildTestSystem();
		admin = await signup(system.app, "ada@acme.example", "Acme");
	});

	it("drafts a summary when an incident opens, which stays a labelled suggestion", async () => {
		const incident = await openIncident("acme-responder");
		const queued = await drafts(incident.id, "acme-responder");

		await system.summaryProcessor.process();
		const done = await drafts(incident.id, "acme-responder");

		expect(queued.items[0]).toMatchObject({ state: "pending", requestedBy: null });
		expect(done).toMatchObject({ total: 1, limit: 20, offset: 0 });
		expect(done.items[0]).toEqual({
			id: queued.items[0]?.id,
			incidentId: incident.id,
			state: "ready",
			summary: "Checkout API latency is high in all regions.",
			suggestedSeverity: "sev1",
			rationale: "Customer-facing and widespread.",
			model: "test/fake-model",
			failureReason: null,
			requestedBy: null,
			createdAt: expect.any(String),
			completedAt: expect.any(String),
		});
		// A suggestion changes nothing on its own.
		const unchanged = IncidentSchema.parse(
			await (await send("GET", `/v1/incidents/${incident.id}`, "acme-responder")).json(),
		);
		expect(unchanged).toMatchObject({ severity: "sev2", summary: null });
	});

	it("drafts a summary when an alert opens an incident", async () => {
		const { sourceId, secret } = await addAlertSource(system.app, admin);
		await system.app.request(
			`/webhooks/alerts/${sourceId}`,
			signedAlert(secret, { dedupKey: "checkout", title: "Checkout is down", severity: "sev1" }),
		);
		await system.processor.processMessages();
		const [incident] = (
			(await (await send("GET", "/v1/incidents", admin)).json()) as { items: { id: string }[] }
		).items;

		await system.summaryProcessor.process();

		expect((await drafts(incident?.id ?? ""))?.items[0]?.state).toBe("ready");
		expect(system.writer.prompts[0]?.user).toContain("Checkout is down");
	});

	it("queues a fresh draft on request, and returns the pending one when asked again", async () => {
		const incident = await openIncident();
		await system.summaryProcessor.process();

		const first = await send("POST", `/v1/incidents/${incident.id}/summary-drafts`, admin);

		expect(first.status).toBe(202);
		const draft = SummaryDraftSchema.parse(await first.json());
		expect(draft).toMatchObject({ state: "pending", incidentId: incident.id });
		expect(draft.requestedBy).not.toBeNull();
		const repeat = SummaryDraftSchema.parse(
			await (await send("POST", `/v1/incidents/${incident.id}/summary-drafts`, admin)).json(),
		);
		expect(repeat.id).toBe(draft.id);
		expect((await drafts(incident.id)).total).toBe(2);
	});

	it("lets a member accept a draft, edited, with its severity", async () => {
		const incident = await openIncident();
		await system.summaryProcessor.process();
		const [draft] = (await drafts(incident.id)).items;

		const res = await send("PUT", `/v1/incidents/${incident.id}/summary`, admin, {
			text: "Checkout API latency is high in EU and US.",
			severity: draft?.suggestedSeverity,
			draftId: draft?.id,
		});

		expect(res.status).toBe(200);
		expect(IncidentSchema.parse(await res.json())).toMatchObject({
			severity: "sev1",
			summary: {
				text: "Checkout API latency is high in EU and US.",
				updatedAt: expect.any(String),
				updatedBy: expect.any(String),
				draftId: draft?.id,
			},
		});
	});

	it("lets a member write or edit the summary by hand, and keeps the severity when none is given", async () => {
		const incident = await openIncident();

		const res = await send("PUT", `/v1/incidents/${incident.id}/summary`, admin, {
			text: "  Payments retries are piling up.  ",
		});

		expect(IncidentSchema.parse(await res.json())).toMatchObject({
			severity: "sev2",
			summary: { text: "Payments retries are piling up.", draftId: null },
		});
	});

	it("refuses another incident's draft, or an unknown one, naming the field", async () => {
		const incident = await openIncident();
		const other = await openIncident();
		await system.summaryProcessor.process();
		const [otherDraft] = (await drafts(other.id)).items;

		for (const draftId of [otherDraft?.id, "00000000-0000-4000-8000-000000000000"]) {
			const res = await send("PUT", `/v1/incidents/${incident.id}/summary`, admin, {
				text: "Summary",
				draftId,
			});

			expect((await problem(res, 404)).errors).toEqual([
				{ path: "draftId", message: "Not a ready draft of this incident" },
			]);
		}
	});

	it("refuses a not-yet-ready draft", async () => {
		const incident = await openIncident();
		const [pending] = (await drafts(incident.id)).items;

		const res = await send("PUT", `/v1/incidents/${incident.id}/summary`, admin, {
			text: "Summary",
			draftId: pending?.id,
		});

		await problem(res, 404);
	});

	it("refuses a severity change on a resolved incident, but still takes its summary", async () => {
		const incident = await openIncident();
		await send("POST", `/v1/incidents/${incident.id}/resolve`, admin, {});
		const path = `/v1/incidents/${incident.id}/summary`;

		const changed = await send("PUT", path, admin, { text: "Done.", severity: "sev1" });
		const same = await send("PUT", path, admin, { text: "Done.", severity: "sev2" });
		const textOnly = await send("PUT", path, admin, { text: "Fixed by a rollback." });

		expect((await problem(changed, 409)).detail).toBe(
			"A resolved incident's severity cannot change",
		);
		expect(same.status).toBe(200);
		expect(IncidentSchema.parse(await textOnly.json()).summary?.text).toBe("Fixed by a rollback.");
	});

	it("skips drafts over the tenant's daily cap, and still returns 202", async () => {
		system = buildTestSystem({ aiDailyCap: 1 });
		admin = await signup(system.app, "ada@acme.example", "Acme");
		await openIncident();
		const second = await openIncident();

		const res = await send("POST", `/v1/incidents/${second.id}/summary-drafts`, admin);

		expect(res.status).toBe(202);
		expect(SummaryDraftSchema.parse(await res.json())).toMatchObject({
			state: "skipped",
			failureReason: "over_daily_cap",
		});
	});

	it.each([
		["an empty text", { text: "   " }, "text"],
		["a text over 2000 characters", { text: "x".repeat(2001) }, "text"],
		["an unknown severity", { text: "s", severity: "p0" }, "severity"],
		["a malformed draft id", { text: "s", draftId: "abc" }, "draftId"],
		["an unknown field", { text: "s", resolve: true }, ""],
	])("rejects %s with 422", async (_case, body, path) => {
		const incident = await openIncident();

		const res = await problem(
			await send("PUT", `/v1/incidents/${incident.id}/summary`, admin, body),
			422,
		);

		expect(res.errors?.map((error) => error.path)).toContain(path);
	});

	it("returns 404 for an unknown incident, 422 for a bad id, and 401 without a token", async () => {
		const unknown = "/v1/incidents/00000000-0000-4000-8000-000000000000";

		await problem(await send("POST", `${unknown}/summary-drafts`, admin), 404);
		await problem(await send("GET", `${unknown}/summary-drafts`, admin), 404);
		await problem(await send("PUT", `${unknown}/summary`, admin, { text: "s" }), 404);
		await problem(await send("GET", "/v1/incidents/abc/summary-drafts", admin), 422);
		await problem(await system.app.request(`${unknown}/summary-drafts`), 401);
	});
});
