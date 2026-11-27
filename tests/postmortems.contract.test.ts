import { beforeEach, describe, expect, it } from "vitest";
import { ProblemSchema } from "../src/contract/common";
import { IncidentSchema } from "../src/contract/incidents";
import {
	PostmortemDraftListSchema,
	PostmortemDraftSchema,
	PostmortemSchema,
} from "../src/contract/postmortems";
import { renderPostmortem } from "../src/services/postmortems/postmortemMarkdown";
import { buildTestSystem, FAKE_POSTMORTEM, signup } from "./helpers";

// Spec: docs/features/ai-postmortems.md

describe("ai postmortems contract", () => {
	let system: ReturnType<typeof buildTestSystem>;
	let admin: string;

	const send = (method: string, path: string, token: string, body?: unknown) =>
		system.app.request(path, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

	const problem = async (res: Response, status: number) => {
		expect(res.status).toBe(status);
		return ProblemSchema.parse(await res.json());
	};

	const openIncident = async () =>
		IncidentSchema.parse(
			await (
				await send("POST", "/v1/incidents", admin, { title: "Checkout is down", severity: "sev1" })
			).json(),
		);

	const resolvedIncident = async () => {
		const incident = await openIncident();
		await send("POST", `/v1/incidents/${incident.id}/resolve`, admin, {});
		return incident;
	};

	const drafts = async (incidentId: string) => {
		const res = await send("GET", `/v1/incidents/${incidentId}/postmortem-drafts`, admin);
		expect(res.status).toBe(200);
		return PostmortemDraftListSchema.parse(await res.json());
	};

	beforeEach(async () => {
		system = buildTestSystem();
		admin = await signup(system.app, "ada@acme.example", "Acme");
	});

	it("drafts a postmortem when an incident resolves, which stays a labelled suggestion", async () => {
		const incident = await resolvedIncident();
		const queued = await drafts(incident.id);

		await system.postmortemProcessor.process();
		const done = await drafts(incident.id);

		expect(queued.items[0]).toMatchObject({ state: "pending", requestedBy: null, content: null });
		expect(done.items[0]).toEqual({
			id: queued.items[0]?.id,
			incidentId: incident.id,
			state: "ready",
			content: FAKE_POSTMORTEM,
			model: "test/fake-model",
			failureReason: null,
			requestedBy: null,
			createdAt: expect.any(String),
			completedAt: expect.any(String),
		});
		// No postmortem exists until a member saves one.
		await problem(await send("GET", `/v1/incidents/${incident.id}/postmortem`, admin), 404);
	});

	it("queues no postmortem draft while an incident is open, and refuses one on request", async () => {
		const incident = await openIncident();

		const res = await send("POST", `/v1/incidents/${incident.id}/postmortem-drafts`, admin);

		expect((await problem(res, 409)).detail).toBe("Postmortems are for resolved incidents");
		expect((await drafts(incident.id)).total).toBe(0);
	});

	it("queues a fresh draft on request, and returns the pending one when asked again", async () => {
		const incident = await resolvedIncident();
		await system.postmortemProcessor.process();

		const first = await send("POST", `/v1/incidents/${incident.id}/postmortem-drafts`, admin);
		const again = await send("POST", `/v1/incidents/${incident.id}/postmortem-drafts`, admin);

		expect(first.status).toBe(202);
		const draft = PostmortemDraftSchema.parse(await first.json());
		expect(draft).toMatchObject({ state: "pending", incidentId: incident.id });
		expect(draft.requestedBy).not.toBeNull();
		expect(PostmortemDraftSchema.parse(await again.json()).id).toBe(draft.id);
	});

	it("saves a draft as Markdown, then a member's edit, then publishes and keeps editing", async () => {
		const incident = await resolvedIncident();
		await system.postmortemProcessor.process();
		const [draft] = (await drafts(incident.id)).items;
		const path = `/v1/incidents/${incident.id}/postmortem`;

		const accepted = PostmortemSchema.parse(
			await (await send("PUT", path, admin, { draftId: draft?.id })).json(),
		);
		const edited = PostmortemSchema.parse(
			await (
				await send("PUT", path, admin, { body: "## Summary\n\nCorrected.", draftId: draft?.id })
			).json(),
		);
		const published = PostmortemSchema.parse(
			await (await send("POST", `${path}/publish`, admin)).json(),
		);
		const afterPublish = PostmortemSchema.parse(
			await (await send("PUT", path, admin, { body: "## Summary\n\nFollow-up added." })).json(),
		);
		const read = PostmortemSchema.parse(await (await send("GET", path, admin)).json());

		expect(accepted).toMatchObject({
			incidentId: incident.id,
			body: renderPostmortem(FAKE_POSTMORTEM),
			state: "draft",
			draftId: draft?.id,
			publishedAt: null,
		});
		expect(edited).toMatchObject({ body: "## Summary\n\nCorrected.", draftId: draft?.id });
		expect(published).toMatchObject({ state: "published", publishedBy: expect.any(String) });
		expect(afterPublish).toMatchObject({
			state: "published",
			draftId: null,
			publishedAt: published.publishedAt,
		});
		expect(read).toEqual(afterPublish);
	});

	it("publishing twice changes nothing", async () => {
		const incident = await resolvedIncident();
		const path = `/v1/incidents/${incident.id}/postmortem`;
		await send("PUT", path, admin, { body: "Written by hand." });

		const first = PostmortemSchema.parse(
			await (await send("POST", `${path}/publish`, admin)).json(),
		);
		const second = PostmortemSchema.parse(
			await (await send("POST", `${path}/publish`, admin)).json(),
		);

		expect(second).toEqual(first);
	});

	it("refuses another incident's draft, a pending one, or an unknown one, naming the field", async () => {
		const incident = await resolvedIncident();
		const other = await resolvedIncident();
		const [pending] = (await drafts(incident.id)).items;
		const ids = [pending?.id, "00000000-0000-4000-8000-000000000000"];
		await system.postmortemProcessor.process();
		const [otherDraft] = (await drafts(other.id)).items;
		// The pending draft is ready by now; queue a new pending one to test with.
		const fresh = PostmortemDraftSchema.parse(
			await (await send("POST", `/v1/incidents/${incident.id}/postmortem-drafts`, admin)).json(),
		);

		for (const draftId of [otherDraft?.id, fresh.id, ids[1]]) {
			const res = await send("PUT", `/v1/incidents/${incident.id}/postmortem`, admin, { draftId });
			expect((await problem(res, 404)).errors).toEqual([
				{ path: "draftId", message: "Not a ready draft of this incident" },
			]);
		}
	});

	it("refuses a postmortem for an unresolved incident, and publishing before one exists", async () => {
		const open = await openIncident();
		const resolved = await resolvedIncident();

		const save = await send("PUT", `/v1/incidents/${open.id}/postmortem`, admin, { body: "Early" });
		const publish = await send("POST", `/v1/incidents/${resolved.id}/postmortem/publish`, admin);

		await problem(save, 409);
		expect((await problem(publish, 404)).detail).toBe("No postmortem yet");
	});

	it("skips a draft over the daily cap shared with summary drafts", async () => {
		system = buildTestSystem({ aiDailyCap: 1 });
		admin = await signup(system.app, "ada@acme.example", "Acme");
		// Opening queues a summary draft, which uses the whole cap.
		const incident = await resolvedIncident();

		const [draft] = (await drafts(incident.id)).items;

		expect(draft).toMatchObject({ state: "skipped", failureReason: "over_daily_cap" });
	});

	it.each([
		["neither body nor draftId", {}, "body"],
		["an empty body", { body: "  " }, "body"],
		["a body over 20,000 characters", { body: "x".repeat(20_001) }, "body"],
		["a malformed draftId", { draftId: "abc" }, "draftId"],
		["an unknown field", { body: "x", state: "published" }, ""],
	])("rejects %s with 422", async (_case, body, path) => {
		const incident = await resolvedIncident();

		const res = await problem(
			await send("PUT", `/v1/incidents/${incident.id}/postmortem`, admin, body),
			422,
		);

		expect(res.errors?.map((error) => error.path)).toContain(path);
	});

	it("returns 404 for an unknown incident, 422 for a bad id, and 401 without a token", async () => {
		const unknown = "/v1/incidents/00000000-0000-4000-8000-000000000000";

		await problem(await send("POST", `${unknown}/postmortem-drafts`, admin), 404);
		await problem(await send("GET", `${unknown}/postmortem-drafts`, admin), 404);
		await problem(await send("GET", `${unknown}/postmortem`, admin), 404);
		await problem(await send("PUT", `${unknown}/postmortem`, admin, { body: "x" }), 404);
		await problem(await send("POST", `${unknown}/postmortem/publish`, admin), 404);
		await problem(await send("GET", "/v1/incidents/abc/postmortem", admin), 422);
		await problem(await system.app.request(`${unknown}/postmortem`), 401);
	});
});
