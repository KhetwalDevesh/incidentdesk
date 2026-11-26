import { beforeEach, describe, expect, it } from "vitest";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { DashboardSchema } from "../src/contract/dashboard";
import { IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema } from "../src/contract/members";
import { authed, buildTestSystem, post, signup } from "./helpers";

// Spec: docs/features/dashboard-stats.md
const PASSWORD = "correct horse battery";

describe("dashboard contract", () => {
	let system: ReturnType<typeof buildTestSystem>;
	let clock: Date;
	let admin: string;

	const invite = async (email: string) =>
		MemberInviteSchema.parse(
			await (
				await system.app.request("/v1/members", authed(admin, { email, role: "responder" }))
			).json(),
		);

	const join = async (email: string) => {
		const member = await invite(email);
		const res = await system.app.request(
			"/v1/auth/setup-password",
			post({ token: member.setupToken, password: PASSWORD }),
		);
		return { id: member.id, token: AccessTokenSchema.parse(await res.json()).accessToken };
	};

	const open = async (severity = "sev2", assigneeId: string | null = null) => {
		const res = await system.app.request(
			"/v1/incidents",
			authed(admin, { title: "Checkout is down", severity }),
		);
		const { id } = IncidentSchema.parse(await res.json());
		if (assigneeId) {
			await system.app.request(`/v1/incidents/${id}/assign`, authed(admin, { assigneeId }));
		}
		return id;
	};

	const act = (id: string, action: "acknowledge" | "resolve") =>
		system.app.request(`/v1/incidents/${id}/${action}`, authed(admin, {}));

	const dashboard = async (token = admin, query = "") => {
		const res = await system.app.request(`/v1/dashboard${query}`, authed(token));
		expect(res.status).toBe(200);
		return DashboardSchema.parse(await res.json());
	};

	beforeEach(async () => {
		clock = new Date("2026-01-10T12:00:00Z");
		system = buildTestSystem({ alertNow: () => clock });
		admin = await signup(system.app, "ada@acme.example", "Acme");
	});

	it("shows zeros for every severity, an empty load and no window, to any member", async () => {
		const grace = await join("grace@acme.example");

		const body = await dashboard(grace.token);

		expect(body).toEqual({
			generatedAt: "2026-01-10T12:00:00.000Z",
			window: null,
			totals: { open: 0, acknowledged: 0, unassigned: 0 },
			bySeverity: {
				sev1: { open: 0, acknowledged: 0 },
				sev2: { open: 0, acknowledged: 0 },
				sev3: { open: 0, acknowledged: 0 },
				sev4: { open: 0, acknowledged: 0 },
			},
			load: [],
			assigneeCount: 0,
		});
	});

	it("counts unresolved incidents and lists who holds them, most loaded first, then by email", async () => {
		const grace = await join("grace@acme.example");
		const alan = await join("alan@acme.example");
		await open("sev1", alan.id);
		await act(await open("sev1", alan.id), "acknowledge");
		await open("sev2", grace.id);
		await open("sev3", alan.id);
		await open("sev3");
		await act(await open("sev4", grace.id), "resolve");
		const ada = await invite("bea@acme.example");
		await open("sev2", ada.id);

		const body = await dashboard(grace.token);

		expect(body.totals).toEqual({ open: 5, acknowledged: 1, unassigned: 1 });
		expect(body.bySeverity).toEqual({
			sev1: { open: 1, acknowledged: 1 },
			sev2: { open: 2, acknowledged: 0 },
			sev3: { open: 2, acknowledged: 0 },
			sev4: { open: 0, acknowledged: 0 },
		});
		expect(body.load).toEqual([
			{ userId: alan.id, email: "alan@acme.example", open: 2, acknowledged: 1, total: 3 },
			{ userId: ada.id, email: "bea@acme.example", open: 1, acknowledged: 0, total: 1 },
			{ userId: grace.id, email: "grace@acme.example", open: 1, acknowledged: 0, total: 1 },
		]);
		expect(body.assigneeCount).toBe(3);
	});

	it("narrows every number to incidents opened in the window", async () => {
		const grace = await join("grace@acme.example");
		clock = new Date("2026-01-09T23:00:00Z");
		await open("sev1", grace.id);
		clock = new Date("2026-01-10T01:00:00Z");
		await open("sev2", grace.id);
		await open("sev2");
		clock = new Date("2026-01-10T12:00:00Z");

		const body = await dashboard(
			admin,
			"?from=2026-01-10T00:00:00%2B00:00&to=2026-01-10T02:00:00Z",
		);

		expect(body.window).toEqual({
			from: "2026-01-10T00:00:00.000Z",
			to: "2026-01-10T02:00:00.000Z",
		});
		expect(body.totals).toEqual({ open: 2, acknowledged: 0, unassigned: 1 });
		expect(body.load.map((row) => row.total)).toEqual([1]);
	});

	it("counts a removed member's incidents as unassigned, and drops them from the load", async () => {
		const grace = await join("grace@acme.example");
		await open("sev1", grace.id);

		await system.app.request(`/v1/members/${grace.id}`, { ...authed(admin), method: "DELETE" });
		const body = await dashboard();

		expect(body.totals.unassigned).toBe(1);
		expect(body.load).toEqual([]);
	});

	it("lists at most 100 members, with the real count of those holding incidents", async () => {
		for (let n = 0; n < 101; n++) {
			const member = await invite(`member${String(n).padStart(3, "0")}@acme.example`);
			await open("sev4", member.id);
		}

		const body = await dashboard();

		expect(body.load).toHaveLength(100);
		expect(body.assigneeCount).toBe(101);
		expect(body.totals.open).toBe(101);
	});

	it.each([
		["only from", "?from=2026-01-10T00:00:00Z", "to"],
		["only to", "?to=2026-01-10T00:00:00Z", "from"],
		["from equal to to", "?from=2026-01-10T00:00:00Z&to=2026-01-10T00:00:00Z", "from"],
		["from after to", "?from=2026-01-11T00:00:00Z&to=2026-01-10T00:00:00Z", "from"],
		["more than 90 days", "?from=2026-01-01T00:00:00Z&to=2026-04-01T00:00:01Z", "to"],
		["a time with no offset", "?from=2026-01-10T00:00:00&to=2026-01-11T00:00:00Z", "from"],
		["a malformed time", "?from=yesterday&to=2026-01-11T00:00:00Z", "from"],
	])("rejects %s with 422, naming the field to fix", async (_case, query, path) => {
		const res = await system.app.request(`/v1/dashboard${query}`, authed(admin));

		expect(res.status).toBe(422);
		expect(ProblemSchema.parse(await res.json()).errors?.map((error) => error.path)).toEqual([
			path,
		]);
	});

	it("accepts a window of exactly 90 days", async () => {
		const body = await dashboard(admin, "?from=2026-01-01T00:00:00Z&to=2026-04-01T00:00:00Z");

		expect(body.window?.from).toBe("2026-01-01T00:00:00.000Z");
	});

	it("requires a token", async () => {
		const res = await system.app.request("/v1/dashboard");

		expect(res.status).toBe(401);
		ProblemSchema.parse(await res.json());
	});
});
