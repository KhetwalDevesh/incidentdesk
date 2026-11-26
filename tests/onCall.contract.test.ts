import { beforeEach, describe, expect, it } from "vitest";
import { AlertSourceSchema, CreatedAlertSourceSchema } from "../src/contract/alerts";
import { AuditEventListSchema } from "../src/contract/audit";
import { AccessTokenSchema } from "../src/contract/auth";
import { ProblemSchema } from "../src/contract/common";
import { IncidentSchema } from "../src/contract/incidents";
import { MemberInviteSchema } from "../src/contract/members";
import {
	OnCallOverrideListSchema,
	OnCallOverrideSchema,
	OnCallScheduleListSchema,
	OnCallScheduleSchema,
	OnCallSchema,
} from "../src/contract/onCall";
import { addAlertSource, authed, buildTestSystem, post, signedAlert, signup } from "./helpers";

// Spec: docs/features/on-call-schedules.md
const PASSWORD = "correct horse battery";
const PATH = "/v1/on-call-schedules";

describe("on-call contract", () => {
	let system: ReturnType<typeof buildTestSystem>;
	let clock: Date;
	let admin: string;
	let grace: { id: string; token: string };
	let alan: { id: string; token: string };

	const send = (method: string, path: string, token: string, body?: unknown) =>
		system.app.request(path, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});

	const join = async (email: string, role = "responder") => {
		const invited = await system.app.request("/v1/members", authed(admin, { email, role }));
		const member = MemberInviteSchema.parse(await invited.json());
		const res = await system.app.request(
			"/v1/auth/setup-password",
			post({ token: member.setupToken, password: PASSWORD }),
		);
		return { id: member.id, token: AccessTokenSchema.parse(await res.json()).accessToken };
	};

	const problem = async (res: Response, status: number) => {
		expect(res.status).toBe(status);
		return ProblemSchema.parse(await res.json());
	};

	// Grace is on call from 2030-01-07 09:00 UTC for a week, then Alan.
	const payments = (overrides: Record<string, unknown> = {}) => ({
		name: "Payments",
		timeZone: "UTC",
		handoffTime: "09:00",
		rotationDays: 7,
		startsOn: "2030-01-07",
		participants: [grace.id, alan.id],
		isDefault: true,
		...overrides,
	});

	const createSchedule = async (body = payments()) => {
		const res = await send("POST", PATH, admin, body);
		expect(res.status).toBe(201);
		return OnCallScheduleSchema.parse(await res.json());
	};

	const openIncident = async (token: string) => {
		const res = await send("POST", "/v1/incidents", token, {
			title: "Checkout is down",
			severity: "sev1",
		});
		expect(res.status).toBe(201);
		return IncidentSchema.parse(await res.json());
	};

	beforeEach(async () => {
		clock = new Date("2030-01-08T12:00:00Z");
		system = buildTestSystem({ alertNow: () => clock });
		admin = await signup(system.app, "ada@acme.example", "Acme");
		grace = await join("grace@acme.example");
		alan = await join("alan@acme.example");
	});

	describe("schedules", () => {
		it("creates, reads, lists, changes and deletes a schedule in the documented shapes", async () => {
			const res = await send("POST", PATH, admin, payments());
			const created = OnCallScheduleSchema.parse(await res.json());

			expect(res.status).toBe(201);
			expect(res.headers.get("Location")).toBe(`${PATH}/${created.id}`);
			expect(created).toEqual({
				id: created.id,
				name: "Payments",
				timeZone: "UTC",
				handoffTime: "09:00",
				rotationDays: 7,
				startsOn: "2030-01-07",
				isDefault: true,
				participants: [
					{ userId: grace.id, email: "grace@acme.example" },
					{ userId: alan.id, email: "alan@acme.example" },
				],
				createdAt: created.createdAt,
			});

			// Every member reads schedules.
			const read = await send("GET", `${PATH}/${created.id}`, grace.token);
			expect(OnCallScheduleSchema.parse(await read.json())).toEqual(created);
			const list = await send("GET", `${PATH}?limit=5`, grace.token);
			expect(OnCallScheduleListSchema.parse(await list.json())).toMatchObject({
				total: 1,
				limit: 5,
				offset: 0,
			});

			const patched = await send("PATCH", `${PATH}/${created.id}`, admin, {
				participants: [alan.id],
				rotationDays: 14,
			});
			expect(OnCallScheduleSchema.parse(await patched.json())).toMatchObject({
				rotationDays: 14,
				participants: [{ userId: alan.id }],
			});

			const deleted = await send("DELETE", `${PATH}/${created.id}`, admin);
			expect(deleted.status).toBe(204);
			await problem(await send("GET", `${PATH}/${created.id}`, admin), 404);
		});

		it("lets only admins create, change or delete schedules", async () => {
			const created = await createSchedule();

			await problem(await send("POST", PATH, grace.token, payments({ name: "Mine" })), 403);
			await problem(await send("PATCH", `${PATH}/${created.id}`, grace.token, { name: "x" }), 403);
			await problem(await send("DELETE", `${PATH}/${created.id}`, grace.token), 403);
		});

		it("refuses a taken name with 409, and a non-member with 404 naming the item", async () => {
			await createSchedule();

			await problem(await send("POST", PATH, admin, payments()), 409);
			const unknown = await problem(
				await send(
					"POST",
					PATH,
					admin,
					payments({
						name: "Search",
						participants: [grace.id, "00000000-0000-4000-8000-000000000001"],
					}),
				),
				404,
			);
			expect(unknown.errors).toEqual([{ path: "participants.1", message: "Member not found" }]);
		});

		it.each([
			["an unknown time zone", () => ({ timeZone: "Mars/Olympus" }), "timeZone"],
			["a fixed offset", () => ({ timeZone: "+01:00" }), "timeZone"],
			["a handover of 24:00", () => ({ handoffTime: "24:00" }), "handoffTime"],
			["an impossible date", () => ({ startsOn: "2030-02-30" }), "startsOn"],
			["a rotation of 29 days", () => ({ rotationDays: 29 }), "rotationDays"],
			["a repeated participant", () => ({ participants: [grace.id, grace.id] }), "participants.1"],
			[
				"more than 50 participants",
				() => ({
					participants: Array.from(
						{ length: 51 },
						(_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
					),
				}),
				"participants",
			],
			["an unknown field", () => ({ owner: "ada" }), ""],
		])("rejects %s with 422", async (_case, change, path) => {
			const res = await problem(await send("POST", PATH, admin, payments(change())), 422);

			expect(res.errors?.map((error) => error.path)).toContain(path);
		});

		it("rejects an empty change, a bad id, and an unknown schedule", async () => {
			const created = await createSchedule();

			await problem(await send("PATCH", `${PATH}/${created.id}`, admin, {}), 422);
			await problem(await send("GET", `${PATH}/abc`, admin), 422);
			await problem(await send("GET", `${PATH}/00000000-0000-4000-8000-000000000000`, admin), 404);
		});
	});

	describe("who is on call", () => {
		it("answers for now by default, and for a given time", async () => {
			const created = await createSchedule();

			const now = OnCallSchema.parse(
				await (await send("GET", `${PATH}/${created.id}/on-call`, grace.token)).json(),
			);
			const nextWeek = OnCallSchema.parse(
				await (
					await send("GET", `${PATH}/${created.id}/on-call?at=2030-01-14T10:00:00%2B01:00`, admin)
				).json(),
			);
			const before = OnCallSchema.parse(
				await (
					await send("GET", `${PATH}/${created.id}/on-call?at=2030-01-01T00:00:00Z`, admin)
				).json(),
			);

			expect(now).toEqual({
				at: "2030-01-08T12:00:00.000Z",
				onCall: {
					userId: grace.id,
					email: "grace@acme.example",
					source: "rotation",
					from: "2030-01-07T09:00:00.000Z",
					until: "2030-01-14T09:00:00.000Z",
				},
			});
			expect(nextWeek.onCall?.userId).toBe(alan.id);
			expect(before.onCall).toBeNull();
		});

		it("rejects a bad time, and an unknown schedule", async () => {
			const created = await createSchedule();

			await problem(await send("GET", `${PATH}/${created.id}/on-call?at=tomorrow`, admin), 422);
			await problem(
				await send("GET", `${PATH}/00000000-0000-4000-8000-000000000000/on-call`, admin),
				404,
			);
		});
	});

	describe("overrides", () => {
		let scheduleId: string;
		const path = () => `${PATH}/${scheduleId}/overrides`;
		const cover = (
			userId: string,
			startsAt = "2030-01-08T00:00:00Z",
			endsAt = "2030-01-09T00:00:00Z",
		) => ({
			userId,
			startsAt,
			endsAt,
		});

		beforeEach(async () => {
			scheduleId = (await createSchedule()).id;
		});

		it("lets a responder put themself on call, which wins over the rotation", async () => {
			const res = await send("POST", path(), alan.token, cover(alan.id));
			const created = OnCallOverrideSchema.parse(await res.json());

			expect(res.status).toBe(201);
			expect(res.headers.get("Location")).toBe(`${path()}/${created.id}`);
			expect(created).toEqual({
				id: created.id,
				userId: alan.id,
				email: "alan@acme.example",
				startsAt: "2030-01-08T00:00:00.000Z",
				endsAt: "2030-01-09T00:00:00.000Z",
				createdBy: alan.id,
				createdAt: "2030-01-08T12:00:00.000Z",
			});
			const onCall = OnCallSchema.parse(
				await (await send("GET", `${PATH}/${scheduleId}/on-call`, grace.token)).json(),
			);
			expect(onCall.onCall).toMatchObject({ userId: alan.id, source: "override" });
		});

		it("lets only an admin add an override for someone else, or remove someone else's", async () => {
			await problem(await send("POST", path(), alan.token, cover(grace.id)), 403);
			const added = OnCallOverrideSchema.parse(
				await (await send("POST", path(), admin, cover(grace.id))).json(),
			);

			await problem(await send("DELETE", `${path()}/${added.id}`, alan.token), 403);
			expect((await send("DELETE", `${path()}/${added.id}`, grace.token)).status).toBe(204);
		});

		it("refuses an overlap with 409, and lists overrides by start time", async () => {
			await send(
				"POST",
				path(),
				admin,
				cover(grace.id, "2030-01-10T00:00:00Z", "2030-01-11T00:00:00Z"),
			);
			await send("POST", path(), admin, cover(alan.id));

			await problem(
				await send(
					"POST",
					path(),
					admin,
					cover(grace.id, "2030-01-08T12:00:00Z", "2030-01-10T12:00:00Z"),
				),
				409,
			);
			const list = OnCallOverrideListSchema.parse(
				await (await send("GET", `${path()}?limit=10`, grace.token)).json(),
			);
			expect(list.total).toBe(2);
			expect(list.items.map((item) => item.userId)).toEqual([alan.id, grace.id]);
		});

		it.each([
			[
				"an end before the start",
				cover("me", "2030-01-09T00:00:00Z", "2030-01-08T00:00:00Z"),
				"endsAt",
			],
			["more than 90 days", cover("me", "2030-01-08T00:00:00Z", "2030-04-09T00:00:00Z"), "endsAt"],
			["an end in the past", cover("me", "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z"), "endsAt"],
			[
				"a time with no offset",
				cover("me", "2030-01-08T00:00:00", "2030-01-09T00:00:00Z"),
				"startsAt",
			],
		])("rejects %s with 422", async (_case, body, path_) => {
			const res = await problem(
				await send("POST", path(), alan.token, { ...body, userId: alan.id }),
				422,
			);

			expect(res.errors?.map((error) => error.path)).toEqual([path_]);
		});

		it("returns 404 for an unknown member, schedule or override", async () => {
			const unknownMember = await problem(
				await send("POST", path(), admin, cover("00000000-0000-4000-8000-000000000001")),
				404,
			);
			expect(unknownMember.errors).toEqual([{ path: "userId", message: "Member not found" }]);
			await problem(
				await send(
					"POST",
					`${PATH}/00000000-0000-4000-8000-000000000000/overrides`,
					admin,
					cover(alan.id),
				),
				404,
			);
			await problem(
				await send("DELETE", `${path()}/00000000-0000-4000-8000-000000000000`, admin),
				404,
			);
		});
	});

	describe("alert source links", () => {
		it("links a source to a schedule, and unlinks it", async () => {
			const schedule = await createSchedule();
			const { sourceId } = await addAlertSource(system.app, admin);

			const linked = await send("PATCH", `/v1/alert-sources/${sourceId}`, admin, {
				onCallScheduleId: schedule.id,
			});
			const unlinked = await send("PATCH", `/v1/alert-sources/${sourceId}`, admin, {
				onCallScheduleId: null,
			});

			expect(linked.status).toBe(200);
			expect(AlertSourceSchema.parse(await linked.json()).onCallScheduleId).toBe(schedule.id);
			expect(AlertSourceSchema.parse(await unlinked.json()).onCallScheduleId).toBeNull();
		});

		it("refuses a responder, an unknown schedule or source, and a bad body", async () => {
			const { sourceId } = await addAlertSource(system.app, admin);
			const path = `/v1/alert-sources/${sourceId}`;

			await problem(await send("PATCH", path, grace.token, { onCallScheduleId: null }), 403);
			const unknown = await problem(
				await send("PATCH", path, admin, {
					onCallScheduleId: "00000000-0000-4000-8000-000000000000",
				}),
				404,
			);
			expect(unknown.errors).toEqual([
				{ path: "onCallScheduleId", message: "On-call schedule not found" },
			]);
			await problem(
				await send("PATCH", "/v1/alert-sources/00000000-0000-4000-8000-000000000000", admin, {
					onCallScheduleId: null,
				}),
				404,
			);
			await problem(await send("PATCH", path, admin, {}), 422);
		});

		it("links a source when it is created", async () => {
			const schedule = await createSchedule();

			const res = await send("POST", "/v1/alert-sources", admin, {
				name: "grafana",
				onCallScheduleId: schedule.id,
			});

			expect(res.status).toBe(201);
			expect(CreatedAlertSourceSchema.parse(await res.json()).onCallScheduleId).toBe(schedule.id);
		});
	});

	describe("assignment when an incident opens", () => {
		const alert = { dedupKey: "checkout", title: "Checkout is down", severity: "sev1" };

		const openFromAlert = async (sourceId: string, secret: string, dedupKey = "checkout") => {
			await system.app.request(
				`/webhooks/alerts/${sourceId}`,
				signedAlert(secret, { ...alert, dedupKey }, String(Math.floor(clock.getTime() / 1000))),
			);
			while ((await system.processor.processMessages()) > 0) {
				// Until every alert is grouped.
			}
			const res = await send("GET", "/v1/incidents", admin);
			const { items } = (await res.json()) as { items: unknown[] };
			return IncidentSchema.parse(items[0]);
		};

		it("assigns a person's incident from the default schedule", async () => {
			await createSchedule();

			const incident = await openIncident(alan.token);

			expect(incident.assignee).toEqual({ id: grace.id, email: "grace@acme.example" });
		});

		it("leaves it unassigned with no default schedule, or nobody on call", async () => {
			expect((await openIncident(alan.token)).assignee).toBeNull();

			await createSchedule(payments({ participants: [] }));

			expect((await openIncident(alan.token)).assignee).toBeNull();
		});

		it("assigns an alert's incident from the source's linked schedule, else the default", async () => {
			await createSchedule();
			const search = await createSchedule(
				payments({ name: "Search", participants: [alan.id], isDefault: false }),
			);
			const linked = await addAlertSource(system.app, admin, "linked");
			const unlinked = await addAlertSource(system.app, admin, "unlinked");
			await send("PATCH", `/v1/alert-sources/${linked.sourceId}`, admin, {
				onCallScheduleId: search.id,
			});

			const fromLinked = await openFromAlert(linked.sourceId, linked.secret, "a");
			clock = new Date("2030-01-08T12:00:01Z");
			const fromUnlinked = await openFromAlert(unlinked.sourceId, unlinked.secret, "b");

			expect(fromLinked.assignee?.id).toBe(alan.id);
			expect(fromUnlinked.assignee?.id).toBe(grace.id);
		});

		it("keeps the assignee through a handover, and a schedule change", async () => {
			const schedule = await createSchedule();
			const incident = await openIncident(admin);

			clock = new Date("2030-01-15T12:00:00Z");
			await send("PATCH", `${PATH}/${schedule.id}`, admin, { participants: [alan.id] });
			const later = IncidentSchema.parse(
				await (await send("GET", `/v1/incidents/${incident.id}`, admin)).json(),
			);

			expect(later.assignee?.id).toBe(grace.id);
		});
	});

	describe("acting on an assigned incident", () => {
		it("lets only the assignee or an admin acknowledge or resolve it", async () => {
			await createSchedule();
			const incident = await openIncident(admin);
			const path = (action: string) => `/v1/incidents/${incident.id}/${action}`;

			const denied = await problem(await send("POST", path("acknowledge"), alan.token, {}), 403);
			const deniedResolve = await problem(await send("POST", path("resolve"), alan.token, {}), 403);
			const acknowledged = await send("POST", path("acknowledge"), grace.token, {});
			const resolved = await send("POST", path("resolve"), admin, {});

			expect(denied.detail).toBe("Only the assignee or an admin can acknowledge this incident");
			expect(deniedResolve.detail).toBe("Only the assignee or an admin can resolve this incident");
			expect(acknowledged.status).toBe(200);
			expect(resolved.status).toBe(200);
		});

		it("lets any member act on an unassigned incident", async () => {
			const incident = await openIncident(admin);

			const res = await send("POST", `/v1/incidents/${incident.id}/acknowledge`, alan.token, {});

			expect(res.status).toBe(200);
		});

		it("unassigns a removed assignee's incidents, so anyone can then act", async () => {
			await createSchedule();
			const incident = await openIncident(admin);

			await send("DELETE", `/v1/members/${grace.id}`, admin);
			const read = IncidentSchema.parse(
				await (await send("GET", `/v1/incidents/${incident.id}`, alan.token)).json(),
			);
			const res = await send("POST", `/v1/incidents/${incident.id}/acknowledge`, alan.token, {});

			expect(read.assignee).toBeNull();
			expect(res.status).toBe(200);
		});
	});

	describe("reassigning", () => {
		it("lets any member hand an incident to another member, or take it", async () => {
			await createSchedule();
			const incident = await openIncident(admin);
			const path = `/v1/incidents/${incident.id}/assign`;

			const handed = await send("POST", path, grace.token, { assigneeId: alan.id });
			const taken = await send("POST", path, grace.token, { assigneeId: grace.id });
			const unchanged = await send("POST", path, alan.token, { assigneeId: grace.id });

			expect(handed.status).toBe(200);
			expect(IncidentSchema.parse(await handed.json()).assignee).toEqual({
				id: alan.id,
				email: "alan@acme.example",
			});
			expect(IncidentSchema.parse(await taken.json()).assignee?.id).toBe(grace.id);
			expect(IncidentSchema.parse(await unchanged.json()).assignee?.id).toBe(grace.id);
			// Opening, then two real changes. The no-op records nothing.
			const timeline = AuditEventListSchema.parse(
				await (await send("GET", `/v1/incidents/${incident.id}/events`, admin)).json(),
			);
			expect(
				timeline.items
					.filter((event) => event.action === "incident.assigned")
					.map((event) => event.details),
			).toEqual([
				{ from: "none", to: grace.id, manual: "false" },
				{ from: grace.id, to: alan.id, manual: "true" },
				{ from: alan.id, to: grace.id, manual: "true" },
			]);
		});

		it("lets only an admin unassign, after which anyone can act", async () => {
			await createSchedule();
			const incident = await openIncident(admin);
			const path = `/v1/incidents/${incident.id}/assign`;

			await problem(await send("POST", path, grace.token, { assigneeId: null }), 403);
			const unassigned = await send("POST", path, admin, { assigneeId: null });
			const acted = await send("POST", `/v1/incidents/${incident.id}/acknowledge`, alan.token, {});

			expect(IncidentSchema.parse(await unassigned.json()).assignee).toBeNull();
			expect(acted.status).toBe(200);
		});

		it("can reassign an acknowledged incident, which stays acknowledged", async () => {
			await createSchedule();
			const incident = await openIncident(admin);
			await send("POST", `/v1/incidents/${incident.id}/acknowledge`, grace.token, {});

			const res = await send("POST", `/v1/incidents/${incident.id}/assign`, grace.token, {
				assigneeId: alan.id,
			});

			expect(IncidentSchema.parse(await res.json())).toMatchObject({
				status: "acknowledged",
				assignee: { id: alan.id },
			});
		});

		it("returns 404 for a member who was removed", async () => {
			const incident = await openIncident(admin);
			await send("DELETE", `/v1/members/${alan.id}`, admin);

			const res = await problem(
				await send("POST", `/v1/incidents/${incident.id}/assign`, grace.token, {
					assigneeId: alan.id,
				}),
				404,
			);

			expect(res.errors).toEqual([{ path: "assigneeId", message: "Member not found" }]);
		});
	});
});
