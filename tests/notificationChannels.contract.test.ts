import { beforeEach, describe, expect, it } from "vitest";
import { ProblemSchema } from "../src/contract/common";
import {
	NotificationChannelListSchema,
	NotificationChannelSchema,
} from "../src/contract/notificationChannels";
import { authed, buildTestApp } from "./helpers";

const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/abcdWXYZ";
const validBody = { name: "#acme-incidents", webhookUrl: WEBHOOK_URL };
const PATH = "/v1/notification-channels";

describe("notification channels contract", () => {
	let app: ReturnType<typeof buildTestApp>;

	beforeEach(() => {
		app = buildTestApp();
	});

	it("creates a channel in the documented shape, with defaults", async () => {
		const res = await app.request(PATH, authed("acme-admin", validBody));

		expect(res.status).toBe(201);
		const channel = NotificationChannelSchema.parse(await res.json());
		expect(channel).toMatchObject({
			kind: "slack_webhook",
			name: "#acme-incidents",
			webhookUrlHint: "…WXYZ",
			minSeverity: "sev4",
			enabled: true,
		});
	});

	it("keeps the given minSeverity and enabled", async () => {
		const res = await app.request(
			PATH,
			authed("acme-admin", { ...validBody, minSeverity: "sev1", enabled: false }),
		);

		expect(NotificationChannelSchema.parse(await res.json())).toMatchObject({
			minSeverity: "sev1",
			enabled: false,
		});
	});

	it("accepts any URL, including plain http and internal hosts", async () => {
		const res = await app.request(
			PATH,
			authed("acme-admin", { name: "internal", webhookUrl: "http://localhost:9000/hook" }),
		);

		expect(res.status).toBe(201);
	});

	it("lists channels in the documented shape, oldest first", async () => {
		// A clock that ticks one second per call, so the two channels never share a created_at.
		let tick = Date.parse("2026-11-01T00:00:00Z");
		app = buildTestApp({
			channelNow: () => {
				tick += 1000;
				return new Date(tick);
			},
		});
		await app.request(PATH, authed("acme-admin", validBody));
		await app.request(PATH, authed("acme-admin", { ...validBody, name: "#oncall" }));

		const res = await app.request(`${PATH}?limit=1`, authed("acme-admin"));

		expect(res.status).toBe(200);
		const page = NotificationChannelListSchema.parse(await res.json());
		expect(page).toMatchObject({ total: 2, limit: 1, offset: 0 });
		expect(page.items.map((item) => item.name)).toEqual(["#acme-incidents"]);
	});

	it("returns 409 for a second channel with the same name", async () => {
		await app.request(PATH, authed("acme-admin", validBody));

		const res = await app.request(PATH, authed("acme-admin", validBody));

		expect(res.status).toBe(409);
		expect(ProblemSchema.parse(await res.json()).code).toBe("CONFLICT");
	});

	it.each([
		["no token", PATH, { method: "POST" }, 401, "UNAUTHENTICATED"],
		["viewer creates", PATH, authed("acme-viewer", validBody), 403, "FORBIDDEN"],
		["responder creates", PATH, authed("acme-responder", validBody), 403, "FORBIDDEN"],
		["viewer lists", PATH, authed("acme-viewer"), 403, "FORBIDDEN"],
		["responder lists", PATH, authed("acme-responder"), 403, "FORBIDDEN"],
		["missing url", PATH, authed("acme-admin", { name: "x" }), 422, "VALIDATION_FAILED"],
		[
			"not a url",
			PATH,
			authed("acme-admin", { name: "x", webhookUrl: "not a url" }),
			422,
			"VALIDATION_FAILED",
		],
		[
			"bad severity",
			PATH,
			authed("acme-admin", { ...validBody, minSeverity: "sev9" }),
			422,
			"VALIDATION_FAILED",
		],
		[
			"empty name",
			PATH,
			authed("acme-admin", { ...validBody, name: " " }),
			422,
			"VALIDATION_FAILED",
		],
		["bad page", `${PATH}?limit=0`, authed("acme-admin"), 422, "VALIDATION_FAILED"],
	])("returns a problem body for %s", async (_name, path, init, status, code) => {
		const res = await app.request(path, init);

		expect(res.status).toBe(status);
		expect(res.headers.get("Content-Type")).toContain("application/problem+json");
		expect(ProblemSchema.parse(await res.json()).code).toBe(code);
	});
});
