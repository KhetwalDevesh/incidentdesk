import { describe, expect, it } from "vitest";
import type { TenantId } from "../shared/identity";
import type { OnCallOverride, OnCallSchedule } from "./types";
import { localInstant, whoIsOnCall } from "./whoIsOnCall";

// Spec: docs/features/on-call-schedules.md, "Who is on call at a time".

const grace = { userId: "00000000-0000-4000-8000-000000000001", email: "grace@acme.example" };
const alan = { userId: "00000000-0000-4000-8000-000000000002", email: "alan@acme.example" };
const ada = { userId: "00000000-0000-4000-8000-000000000003", email: "ada@acme.example" };

const schedule = (overrides: Partial<OnCallSchedule> = {}): OnCallSchedule => ({
	id: "s",
	tenantId: "t" as TenantId,
	name: "Payments",
	timeZone: "Europe/London",
	handoffTime: "09:00",
	rotationDays: 7,
	startsOn: "2026-01-05",
	isDefault: true,
	participants: [grace, alan, ada],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	...overrides,
});

const override = (
	member: typeof grace,
	startsAt: string,
	endsAt: string,
	id = "o1",
): OnCallOverride => ({
	id,
	tenantId: "t" as TenantId,
	scheduleId: "s",
	userId: member.userId,
	email: member.email,
	startsAt: new Date(startsAt),
	endsAt: new Date(endsAt),
	createdBy: member.userId,
	createdAt: new Date("2026-01-01T00:00:00Z"),
});

const at = (iso: string) => new Date(iso);

describe("whoIsOnCall", () => {
	it("starts with the first member at the start date's handover time", () => {
		const shift = whoIsOnCall(schedule(), [], at("2026-01-05T09:00:00Z"));

		expect(shift).toEqual({
			...grace,
			source: "rotation",
			from: at("2026-01-05T09:00:00Z"),
			until: at("2026-01-12T09:00:00Z"),
		});
	});

	it("hands over to the next member, and wraps round to the first", () => {
		expect(whoIsOnCall(schedule(), [], at("2026-01-12T08:59:59Z"))?.userId).toBe(grace.userId);
		expect(whoIsOnCall(schedule(), [], at("2026-01-12T09:00:00Z"))?.userId).toBe(alan.userId);
		expect(whoIsOnCall(schedule(), [], at("2026-01-19T09:00:00Z"))?.userId).toBe(ada.userId);
		expect(whoIsOnCall(schedule(), [], at("2026-01-26T09:00:00Z"))?.userId).toBe(grace.userId);
		// A year later: 52 weeks is 52 shifts, so 52 mod 3 = 1, Alan.
		expect(whoIsOnCall(schedule(), [], at("2027-01-04T09:30:00Z"))?.userId).toBe(alan.userId);
	});

	it("has nobody on call before the rotation starts, or with an empty rotation", () => {
		expect(whoIsOnCall(schedule(), [], at("2026-01-05T08:59:00Z"))).toBeNull();
		expect(whoIsOnCall(schedule({ participants: [] }), [], at("2026-02-01T00:00:00Z"))).toBeNull();
	});

	it("prefers an override covering the time, and hands back when it ends", () => {
		const cover = override(ada, "2026-01-07T00:00:00Z", "2026-01-08T00:00:00Z");

		expect(whoIsOnCall(schedule(), [cover], at("2026-01-07T12:00:00Z"))).toEqual({
			...ada,
			source: "override",
			from: cover.startsAt,
			until: cover.endsAt,
		});
		expect(whoIsOnCall(schedule(), [cover], at("2026-01-08T00:00:00Z"))?.userId).toBe(grace.userId);
	});

	it("ends a rotation shift early when an override starts before the handover", () => {
		const cover = override(ada, "2026-01-07T00:00:00Z", "2026-01-08T00:00:00Z");

		const shift = whoIsOnCall(schedule(), [cover], at("2026-01-06T12:00:00Z"));

		expect(shift).toMatchObject({ ...grace, source: "rotation", until: cover.startsAt });
	});

	it("covers a time before the rotation starts with an override", () => {
		const cover = override(alan, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");

		expect(whoIsOnCall(schedule(), [cover], at("2026-01-01T06:00:00Z"))?.userId).toBe(alan.userId);
	});

	it("hands over at the local time across a daylight saving change", () => {
		// London moves to BST on 2026-03-29. 09:00 local is 09:00Z before and 08:00Z after.
		const daily = schedule({ rotationDays: 1, startsOn: "2026-03-27" });

		expect(whoIsOnCall(daily, [], at("2026-03-28T12:00:00Z"))).toMatchObject({
			from: at("2026-03-28T09:00:00Z"),
			until: at("2026-03-29T08:00:00Z"),
		});
		// That shift was an hour shorter. The next starts at 08:00Z, 09:00 BST.
		expect(whoIsOnCall(daily, [], at("2026-03-29T08:00:00Z"))).toMatchObject({
			userId: ada.userId,
			from: at("2026-03-29T08:00:00Z"),
		});
		// Back to GMT on 2026-10-25: the shift before it is an hour longer.
		expect(whoIsOnCall(daily, [], at("2026-10-24T12:00:00Z"))).toMatchObject({
			from: at("2026-10-24T08:00:00Z"),
			until: at("2026-10-25T09:00:00Z"),
		});
	});

	it("uses the zone of the schedule, not the server", () => {
		const tokyo = schedule({ timeZone: "Asia/Tokyo" });

		// 09:00 in Tokyo (UTC+9) is 00:00Z.
		expect(whoIsOnCall(tokyo, [], at("2026-01-05T00:00:00Z"))?.from).toEqual(
			at("2026-01-05T00:00:00Z"),
		);
	});
});

describe("localInstant", () => {
	it("moves a time the clocks skip to the first valid time after it", () => {
		// 01:30 on 2026-03-29 does not exist in London: clocks jump from 01:00 to 02:00.
		expect(localInstant(Date.UTC(2026, 2, 29, 1, 30), "Europe/London")).toBe(
			Date.parse("2026-03-29T01:00:00Z"),
		);
	});

	it("picks the first of a time the clocks repeat", () => {
		// 01:30 on 2026-10-25 happens twice in London: first in BST (00:30Z), then GMT (01:30Z).
		expect(localInstant(Date.UTC(2026, 9, 25, 1, 30), "Europe/London")).toBe(
			Date.parse("2026-10-25T00:30:00Z"),
		);
	});
});
