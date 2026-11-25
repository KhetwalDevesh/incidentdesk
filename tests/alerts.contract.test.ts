import { beforeEach, describe, expect, it } from "vitest";
import { AlertListSchema } from "../src/contract/alerts";
import { ProblemSchema } from "../src/contract/common";
import { addAlertSource, authed, buildTestSystem, signedAlert } from "./helpers";

const PATH = "/v1/alerts";
const NOW = new Date("2026-06-01T12:00:00.000Z");
const alert = { dedupKey: "db-cpu-high", title: "DB CPU above 90%", severity: "sev2" };

describe("alerts contract", () => {
	let system: ReturnType<typeof buildTestSystem>;
	let send: (body: unknown) => Response | Promise<Response>;

	beforeEach(async () => {
		system = buildTestSystem({ alertNow: () => NOW });
		const { sourceId, secret } = await addAlertSource(system.app, "acme-admin");
		send = (body) =>
			system.app.request(
				`/webhooks/alerts/${sourceId}`,
				signedAlert(secret, body, String(NOW.getTime() / 1000)),
			);
	});

	it("lists alerts in the documented shape, with their incident once processed", async () => {
		await send({ ...alert, details: { host: "db-1" } });
		await system.processor.processBatch();

		const res = await system.app.request(PATH, authed("acme-admin"));

		expect(res.status).toBe(200);
		const page = AlertListSchema.parse(await res.json());
		expect(page).toMatchObject({ total: 1, limit: 20, offset: 0 });
		expect(page.items[0]).toMatchObject({
			dedupKey: "db-cpu-high",
			details: { host: "db-1" },
			state: "processed",
			attempts: 1,
			processedAt: NOW.toISOString(),
		});
		expect(page.items[0]?.incidentId).not.toBeNull();
	});

	it("filters by state, so an admin can find failed alerts", async () => {
		await send(alert);
		await send({ ...alert, dedupKey: "disk-full" });
		const [first] = await system.alerts.claimDue(NOW, 1, NOW);
		await system.alerts.fail(first?.tenantId ?? never(), first?.id ?? never(), "boom", null, NOW);

		const failed = await system.app.request(`${PATH}?state=failed`, authed("acme-admin"));
		const pending = await system.app.request(`${PATH}?state=pending`, authed("acme-admin"));

		const failedPage = AlertListSchema.parse(await failed.json());
		expect(failedPage).toMatchObject({ total: 1, state: "failed" });
		expect(failedPage.items[0]).toMatchObject({ id: first?.id, state: "failed" });
		expect(AlertListSchema.parse(await pending.json()).total).toBe(1);
	});

	it("never returns the internal error text", async () => {
		await send(alert);
		const [claimed] = await system.alerts.claimDue(NOW, 1, NOW);
		const internal = "connection to 10.0.0.5:5432 refused";
		await system.alerts.fail(
			claimed?.tenantId ?? never(),
			claimed?.id ?? never(),
			internal,
			null,
			NOW,
		);

		const res = await system.app.request(PATH, authed("acme-admin"));

		const text = await res.text();
		expect(text).not.toContain("10.0.0.5");
		expect(text).not.toContain("lastError");
		AlertListSchema.parse(JSON.parse(text));
	});

	it.each([
		["no token", PATH, {}, 401, "UNAUTHENTICATED"],
		["viewer", PATH, authed("acme-viewer"), 403, "FORBIDDEN"],
		["responder", PATH, authed("acme-responder"), 403, "FORBIDDEN"],
		["bad state", `${PATH}?state=lost`, authed("acme-admin"), 422, "VALIDATION_FAILED"],
		["bad page", `${PATH}?limit=101`, authed("acme-admin"), 422, "VALIDATION_FAILED"],
	])("returns a problem body for %s", async (_name, path, init, status, code) => {
		const res = await system.app.request(path, init);

		expect(res.status).toBe(status);
		expect(ProblemSchema.parse(await res.json()).code).toBe(code);
	});
});

function never(): never {
	throw new Error("expected a claimed alert");
}
