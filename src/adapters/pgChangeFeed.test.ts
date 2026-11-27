import { describe, expect, it } from "vitest";
import { parseNotice } from "./pgChangeFeed";

describe("parseNotice", () => {
	it("reads each kind of notice", () => {
		const notices = [
			{ kind: "incident", tenantId: "t", id: "i", event: "incident.reassigned" },
			{ kind: "on_call_schedule", tenantId: "t", id: "s", event: "on_call_schedule.deleted" },
			{
				kind: "on_call_override",
				tenantId: "t",
				scheduleId: "s",
				id: "o",
				event: "on_call_override.created",
			},
			{ kind: "members_removed", tenantId: "t", userIds: ["u1", "u2"] },
		];

		for (const notice of notices) expect(parseNotice(JSON.stringify(notice))).toEqual(notice);
	});

	it.each([
		["not JSON", "{"],
		["no payload", undefined],
		["an unknown kind", JSON.stringify({ kind: "billing", tenantId: "t", id: "i" })],
		["an unknown event", JSON.stringify({ kind: "incident", tenantId: "t", id: "i", event: "x" })],
		["a missing tenant", JSON.stringify({ kind: "incident", id: "i", event: "incident.opened" })],
		[
			"an empty id",
			JSON.stringify({ kind: "incident", tenantId: "t", id: "", event: "incident.opened" }),
		],
		[
			"too many user ids",
			JSON.stringify({
				kind: "members_removed",
				tenantId: "t",
				userIds: Array.from({ length: 51 }, (_, n) => `u${n}`),
			}),
		],
	])("refuses %s", (_case, payload) => {
		expect(parseNotice(payload)).toBeNull();
	});
});
