import { beforeEach, describe, expect, it } from "vitest";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import {
	MemberBatchSchema,
	type MemberInviteResponse,
	MemberInviteSchema,
	MemberListSchema,
	MemberSchema,
} from "../src/contract/members";
import { authed, buildTestApp, post, signup } from "./helpers";

// Spec: docs/features/member-management.md
const PASSWORD = "correct horse battery";

describe("member management contract", () => {
	let app: ReturnType<typeof buildTestApp>;
	let admin: string;

	beforeEach(async () => {
		app = buildTestApp();
		admin = await signup(app, "ada@acme.example", "Acme");
	});

	const send = (method: string, path: string, token: string, body?: unknown) =>
		app.request(path, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

	const invite = async (email: string, role = "responder"): Promise<MemberInviteResponse> => {
		const res = await app.request("/v1/members", authed(admin, { email, role }));
		expect(res.status).toBe(201);
		return MemberInviteSchema.parse(await res.json());
	};

	// Invites and sets a password, returning the member and a token for them.
	const join = async (email: string, role = "responder") => {
		const member = await invite(email, role);
		const res = await app.request(
			"/v1/auth/setup-password",
			post({ token: member.setupToken, password: PASSWORD }),
		);
		return { member, token: AccessTokenSchema.parse(await res.json()).accessToken };
	};

	const members = async () =>
		MemberListSchema.parse(await (await app.request("/v1/members", authed(admin))).json()).items;

	const adminId = async () => (await members()).find((m) => m.email === "ada@acme.example")?.id;

	const problem = async (res: Response, status: number) => {
		expect(res.status).toBe(status);
		return ProblemSchema.parse(await res.json());
	};

	describe("PATCH /v1/members/{id}", () => {
		it("changes an active member's role, which applies to their next request", async () => {
			const { member, token } = await join("grace@acme.example", "responder");

			const before = await app.request("/v1/alert-sources", authed(token));
			const res = await send("PATCH", `/v1/members/${member.id}`, admin, { role: "admin" });

			expect(before.status).toBe(403);
			expect(res.status).toBe(200);
			expect(MemberSchema.parse(await res.json())).toMatchObject({
				id: member.id,
				role: "admin",
				status: "active",
			});
			expect((await app.request("/v1/alert-sources", authed(token))).status).toBe(200);
		});

		// Spec: docs/features/on-call-schedules.md. The role is gone, not just hidden.
		it("refuses the removed viewer role in an invite, a change or a bulk change", async () => {
			const { id } = await invite("grace@acme.example");

			const invited = await app.request(
				"/v1/members",
				authed(admin, { email: "linus@acme.example", role: "viewer" }),
			);
			const changed = await send("PATCH", `/v1/members/${id}`, admin, { role: "viewer" });
			const bulk = await send("PATCH", "/v1/members", admin, {
				changes: [{ id, role: "viewer" }],
			});

			for (const res of [invited, changed, bulk]) {
				expect((await problem(res, 422)).errors?.[0]?.path).toMatch(/role$/);
			}
			expect((await members()).map((m) => m.role).sort()).toEqual(["admin", "responder"]);
		});

		it("changes a pending member's role, and treats the current role as a no-op", async () => {
			const member = await invite("grace@acme.example", "responder");

			const changed = await send("PATCH", `/v1/members/${member.id}`, admin, { role: "admin" });
			const same = await send("PATCH", `/v1/members/${member.id}`, admin, { role: "admin" });

			expect(MemberSchema.parse(await changed.json())).toMatchObject({
				role: "admin",
				status: "pending",
			});
			expect(same.status).toBe(200);
			expect(MemberSchema.parse(await same.json()).role).toBe("admin");
		});

		it("refuses the admin's own role, even with another admin present", async () => {
			await join("grace@acme.example", "admin");

			const res = await send("PATCH", `/v1/members/${await adminId()}`, admin, {
				role: "responder",
			});

			expect((await problem(res, 409)).detail).toBe("You cannot change your own role");
		});

		it("returns 404 for an unknown member, and 422 for a bad id or role", async () => {
			await problem(
				await send("PATCH", "/v1/members/00000000-0000-4000-8000-000000000000", admin, {
					role: "responder",
				}),
				404,
			);
			await problem(await send("PATCH", "/v1/members/abc", admin, { role: "responder" }), 422);
			const { id } = await invite("grace@acme.example");
			await problem(await send("PATCH", `/v1/members/${id}`, admin, { role: "owner" }), 422);
		});
	});

	describe("DELETE /v1/members/{id}", () => {
		it("removes an active member, whose token stops working at once", async () => {
			const { member, token } = await join("grace@acme.example");

			const res = await send("DELETE", `/v1/members/${member.id}`, admin);

			expect(res.status).toBe(204);
			expect(await res.text()).toBe("");
			expect((await app.request("/v1/incidents", authed(token))).status).toBe(401);
			expect((await members()).map((m) => m.email)).toEqual(["ada@acme.example"]);
		});

		it("cancels a pending invite, so its setup token no longer works", async () => {
			const member = await invite("grace@acme.example");

			await send("DELETE", `/v1/members/${member.id}`, admin);
			const setup = await app.request(
				"/v1/auth/setup-password",
				post({ token: member.setupToken, password: PASSWORD }),
			);

			expect((await problem(setup, 401)).detail).toBe("Setup token is invalid, used or expired");
		});

		it("lets the same email be invited again, as a new member", async () => {
			const first = await invite("grace@acme.example");
			await send("DELETE", `/v1/members/${first.id}`, admin);

			const again = await invite("grace@acme.example", "admin");

			expect(again.id).not.toBe(first.id);
			expect(again).toMatchObject({
				email: "grace@acme.example",
				role: "admin",
				status: "pending",
			});
		});

		it("refuses the admin themselves, even with another admin present", async () => {
			await join("grace@acme.example", "admin");

			const res = await send("DELETE", `/v1/members/${await adminId()}`, admin);

			expect((await problem(res, 409)).detail).toBe("You cannot remove yourself");
		});

		it("never lets two admins removing each other at once leave the tenant without one", async () => {
			const grace = await join("grace@acme.example", "admin");
			const ada = await adminId();

			const results = await Promise.all([
				send("DELETE", `/v1/members/${grace.member.id}`, admin),
				send("DELETE", `/v1/members/${ada}`, grace.token),
			]);

			// Which one loses depends on timing: 409 if both were signed in when the second
			// removal ran (accountRepository.parity covers that case deterministically), or 401
			// if the loser was already removed. Either way, exactly one admin remains.
			const statuses = results.map((res) => res.status);
			expect(statuses.filter((status) => status === 204)).toHaveLength(1);
			expect(statuses.filter((status) => status === 409 || status === 401)).toHaveLength(1);
			const remaining = await app.request(
				"/v1/members",
				authed(statuses[0] === 204 ? admin : grace.token),
			);
			const admins = MemberListSchema.parse(await remaining.json()).items.filter(
				(m) => m.role === "admin",
			);
			expect(admins).toHaveLength(1);
		});

		it("returns 404 for an unknown member and 422 for a malformed id", async () => {
			await problem(
				await send("DELETE", "/v1/members/00000000-0000-4000-8000-000000000000", admin),
				404,
			);
			await problem(await send("DELETE", "/v1/members/abc", admin), 422);
		});
	});

	describe("bulk changes", () => {
		it("changes every role in one request, returning members in request order", async () => {
			const grace = await invite("grace@acme.example", "responder");
			const linus = await invite("linus@acme.example", "responder");

			const res = await send("PATCH", "/v1/members", admin, {
				changes: [
					{ id: linus.id, role: "admin" },
					{ id: grace.id, role: "responder" },
				],
			});

			expect(res.status).toBe(200);
			expect(MemberBatchSchema.parse(await res.json()).items).toMatchObject([
				{ id: linus.id, role: "admin" },
				{ id: grace.id, role: "responder" },
			]);
		});

		it("demotes one admin while promoting another in the same request", async () => {
			const grace = await join("grace@acme.example", "admin");
			const linus = await join("linus@acme.example", "responder");

			const res = await send("PATCH", "/v1/members", admin, {
				changes: [
					{ id: grace.member.id, role: "responder" },
					{ id: linus.member.id, role: "admin" },
				],
			});

			expect(res.status).toBe(200);
		});

		it("changes nothing when any item fails, and lists every failing item", async () => {
			const grace = await invite("grace@acme.example", "responder");

			const res = await send("PATCH", "/v1/members", admin, {
				changes: [
					{ id: grace.id, role: "admin" },
					{ id: "00000000-0000-4000-8000-000000000001", role: "admin" },
					{ id: "00000000-0000-4000-8000-000000000002", role: "responder" },
				],
			});

			expect((await problem(res, 404)).errors).toEqual([
				{ path: "changes.1.id", message: "Member not found" },
				{ path: "changes.2.id", message: "Member not found" },
			]);
			expect((await members()).find((m) => m.id === grace.id)?.role).toBe("responder");
		});

		it("refuses a batch that includes the caller, naming the item", async () => {
			const grace = await invite("grace@acme.example", "responder");

			const res = await send("PATCH", "/v1/members", admin, {
				changes: [
					{ id: grace.id, role: "admin" },
					{ id: await adminId(), role: "responder" },
				],
			});

			expect((await problem(res, 409)).errors).toEqual([
				{ path: "changes.1.id", message: "This is you" },
			]);
		});

		it("removes every member in one request, or none", async () => {
			const grace = await join("grace@acme.example");
			const linus = await invite("linus@acme.example");

			const refused = await send("POST", "/v1/members/remove", admin, {
				ids: [grace.member.id, "00000000-0000-4000-8000-000000000001"],
			});
			expect((await problem(refused, 404)).errors).toEqual([
				{ path: "ids.1", message: "Member not found" },
			]);
			expect(await members()).toHaveLength(3);

			const res = await send("POST", "/v1/members/remove", admin, {
				ids: [grace.member.id, linus.id],
			});

			expect(res.status).toBe(204);
			expect((await members()).map((m) => m.email)).toEqual(["ada@acme.example"]);
			expect((await app.request("/v1/incidents", authed(grace.token))).status).toBe(401);
		});

		it.each([
			["no changes", { changes: [] }],
			[
				"a repeated id",
				{
					changes: [0, 0].map(() => ({
						id: "00000000-0000-4000-8000-000000000001",
						role: "responder",
					})),
				},
			],
			[
				"more than 50 changes",
				{
					changes: Array.from({ length: 51 }, (_, n) => ({
						id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
						role: "responder",
					})),
				},
			],
			[
				"an unknown field",
				{
					changes: [{ id: "00000000-0000-4000-8000-000000000001", role: "responder", email: "x" }],
				},
			],
		])("rejects a bulk role change with %s", async (_case, body) => {
			await problem(await send("PATCH", "/v1/members", admin, body), 422);
		});

		it("rejects a bulk removal with a repeated id, naming the repeat", async () => {
			const id = "00000000-0000-4000-8000-000000000001";

			const res = await send("POST", "/v1/members/remove", admin, { ids: [id, id] });

			expect((await problem(res, 422)).errors).toEqual([{ path: "ids.1", message: "Repeated id" }]);
		});
	});
});
