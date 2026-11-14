import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createReceiver, type Delivery, parseMode } from "./dev-receiver";

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
	await close?.();
	close = undefined;
});

const start = async (mode: string) => {
	const { server, received } = createReceiver({ mode });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	close = () =>
		new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		});
	const { port } = server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}`, received };
};

const deliver = (base: string, body = '{"text":"hello"}', signal?: AbortSignal) =>
	fetch(`${base}/hook`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		signal,
	});

describe("parseMode", () => {
	it.each(["ok", "error", "reject", "hang", "fail-first:2"])("accepts %s", (mode) => {
		expect(parseMode(mode)).not.toBeNull();
	});

	it.each(["", "500", "fail-first", "fail-first:x", "slow"])("rejects %j", (mode) => {
		expect(parseMode(mode)).toBeNull();
	});
});

describe("dev receiver", () => {
	it("answers 200 and records the delivery", async () => {
		const { base, received } = await start("ok");

		const res = await deliver(base);

		expect(res.status).toBe(200);
		expect(received).toEqual([
			expect.objectContaining<Partial<Delivery>>({
				n: 1,
				method: "POST",
				path: "/hook",
				contentType: "application/json",
				body: '{"text":"hello"}',
				answered: 200,
			}),
		]);
	});

	it.each([
		["error", 500],
		["reject", 404],
	])("answers %s with %i", async (mode, status) => {
		const { base } = await start(mode);

		expect((await deliver(base)).status).toBe(status);
	});

	it("fails the first N deliveries, then succeeds", async () => {
		const { base } = await start("fail-first:2");

		const statuses = [];
		for (let i = 0; i < 4; i++) statuses.push((await deliver(base)).status);

		expect(statuses).toEqual([500, 500, 200, 200]);
	});

	it("never answers in hang mode, but still records the delivery", async () => {
		const { base, received } = await start("hang");

		await expect(deliver(base, "{}", AbortSignal.timeout(200))).rejects.toThrow();
		expect(received.map((d) => d.answered)).toEqual(["none"]);
	});

	it("switches mode at runtime and keeps every delivery in the list", async () => {
		const { base } = await start("ok");

		expect((await deliver(base)).status).toBe(200);
		expect((await fetch(`${base}/_mode/error`)).status).toBe(200);
		expect((await deliver(base)).status).toBe(500);
		expect((await fetch(`${base}/_mode/nonsense`)).status).toBe(400);

		const list = (await (await fetch(`${base}/_received`)).json()) as Delivery[];
		expect(list.map((d) => [d.n, d.answered])).toEqual([
			[1, 200],
			[2, 500],
		]);
	});

	it("counts fail-first from the mode switch", async () => {
		const { base } = await start("ok");

		await deliver(base);
		await fetch(`${base}/_mode/fail-first:1`);

		expect((await deliver(base)).status).toBe(500);
		expect((await deliver(base)).status).toBe(200);
	});

	it("refuses an unknown starting mode", () => {
		expect(() => createReceiver({ mode: "slow" })).toThrow(/Unknown mode/);
	});
});
