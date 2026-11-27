import { describe, expect, it } from "vitest";
import { buildPrompt } from "../services/summaries/prompt";
import { createChatCompletionsSummaryWriter } from "./chatCompletionsSummaryWriter";

// Spec: docs/features/ai-summaries.md, "The AI call". fetch is stubbed: no network.

const prompt = buildPrompt({ title: "Checkout is down", severity: "sev1" }, []);

const stub = (respond: () => Response | Promise<Response>) => {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchStub = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return respond();
	}) as typeof fetch;
	return { calls, fetchStub };
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const completion = (content: unknown, extra: Record<string, unknown> = {}) =>
	json({
		model: "qwen/qwen3-30b-a3b-instruct-2507",
		choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1200, completion_tokens: 80 },
		...extra,
	});

const writerWith = (fetchStub: typeof fetch, denyDataCollection = true) =>
	createChatCompletionsSummaryWriter({
		baseUrl: "https://openrouter.ai/api/v1/",
		apiKey: "sk-or-test",
		model: "openrouter/free",
		denyDataCollection,
		fetch: fetchStub,
	});

describe("chat completions summary writer", () => {
	it("sends the prompt, the strict schema and the data policy, with the key in a header", async () => {
		const { calls, fetchStub } = stub(() => completion('{"x":1}'));

		await writerWith(fetchStub).write(prompt);

		const [call] = calls;
		expect(call?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(call?.init.method).toBe("POST");
		expect(call?.init.headers).toMatchObject({ Authorization: "Bearer sk-or-test" });
		const body = JSON.parse(String(call?.init.body));
		expect(body).toMatchObject({
			model: "openrouter/free",
			messages: [
				{ role: "system", content: prompt.system },
				{ role: "user", content: prompt.user },
			],
			response_format: {
				type: "json_schema",
				json_schema: { name: "incident_summary", strict: true, schema: prompt.schema.schema },
			},
			provider: { require_parameters: true, data_collection: "deny" },
		});
		expect(JSON.stringify(body)).not.toContain("sk-or-test");
	});

	it("leaves the data policy out when it is relaxed for free development models", async () => {
		const { calls, fetchStub } = stub(() => completion("{}"));

		await writerWith(fetchStub, false).write(prompt);

		expect(JSON.parse(String(calls[0]?.init.body)).provider).toEqual({ require_parameters: true });
	});

	it("returns the content, the model that answered and the token counts", async () => {
		const { fetchStub } = stub(() => completion('{"summary":"s"}'));

		expect(await writerWith(fetchStub).write(prompt)).toEqual({
			kind: "ok",
			content: '{"summary":"s"}',
			model: "qwen/qwen3-30b-a3b-instruct-2507",
			inputTokens: 1200,
			outputTokens: 80,
		});
	});

	it.each([429, 408, 500, 502, 503, 524, 529])("retries HTTP %i", async (status) => {
		const { fetchStub } = stub(() =>
			json({ error: { code: status, message: "echo: prompt" } }, status),
		);

		expect(await writerWith(fetchStub).write(prompt)).toEqual({
			kind: "retry",
			error: `HTTP ${status}`,
		});
	});

	it.each([400, 401, 402, 403, 404])(
		"fails at once on HTTP %i, without the provider's message",
		async (status) => {
			const { fetchStub } = stub(() =>
				json({ error: { code: status, message: "secret detail from provider" } }, status),
			);

			const result = await writerWith(fetchStub).write(prompt);

			expect(result).toEqual({ kind: "fail", reason: "provider_error", error: `HTTP ${status}` });
			expect(JSON.stringify(result)).not.toContain("secret detail");
		},
	);

	it("retries an error reported inside a 200, and a lost connection or timeout", async () => {
		const inBody = stub(() =>
			completion(null, { choices: [{ error: { code: 502 }, finish_reason: "error" }] }),
		);
		const lost = stub(() => {
			throw new TypeError("fetch failed: https://user@host");
		});
		const slow = stub(() => {
			throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
		});

		expect(await writerWith(inBody.fetchStub).write(prompt)).toMatchObject({ kind: "retry" });
		expect(await writerWith(lost.fetchStub).write(prompt)).toEqual({
			kind: "retry",
			error: "network error",
		});
		expect(await writerWith(slow.fetchStub).write(prompt)).toEqual({
			kind: "retry",
			error: "timeout",
		});
	});

	it("fails as invalid output when the answer is empty or cut off", async () => {
		const empty = stub(() => completion(""));
		const cut = stub(() =>
			json({ model: "m", choices: [{ message: { content: '{"summ' }, finish_reason: "length" }] }),
		);

		expect(await writerWith(empty.fetchStub).write(prompt)).toMatchObject({
			kind: "fail",
			reason: "invalid_output",
		});
		expect(await writerWith(cut.fetchStub).write(prompt)).toMatchObject({
			kind: "fail",
			reason: "invalid_output",
		});
	});
});
