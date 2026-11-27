import type { SummaryPrompt, SummaryWriter, WriterResult } from "../domain/summaries/types";

// Spec: docs/features/ai-summaries.md, "The AI call". The only file that knows the provider's
// protocol: the OpenAI-compatible chat completions API, as OpenRouter serves it. Any server
// speaking it (Groq, Ollama, vLLM) works by configuration alone.

export type ChatCompletionsConfig = {
	// Such as https://openrouter.ai/api/v1. Operator configuration, never user input.
	baseUrl: string;
	apiKey: string;
	model: string;
	// OpenRouter: route only to providers that do not store or train on prompts.
	denyDataCollection: boolean;
	timeoutMs?: number;
	maxOutputTokens?: number;
	fetch?: typeof fetch;
};

// Worth retrying: rate limits, timeouts and server-side failures (OpenRouter uses 524 and 529
// for provider timeouts and overload).
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 524, 529]);

type ChatCompletion = {
	model?: unknown;
	error?: unknown;
	choices?: { message?: { content?: unknown }; finish_reason?: unknown; error?: unknown }[];
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

const count = (value: unknown) => (typeof value === "number" && value >= 0 ? value : null);

export const createChatCompletionsSummaryWriter = ({
	baseUrl,
	apiKey,
	model,
	denyDataCollection,
	timeoutMs = 60_000,
	maxOutputTokens = 800,
	fetch: send = fetch,
}: ChatCompletionsConfig): SummaryWriter => ({
	async write(prompt: SummaryPrompt): Promise<WriterResult> {
		let res: Response;
		try {
			res = await send(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"X-Title": "IncidentDesk",
				},
				body: JSON.stringify({
					model,
					messages: [
						{ role: "system", content: prompt.system },
						{ role: "user", content: prompt.user },
					],
					response_format: {
						type: "json_schema",
						json_schema: { name: prompt.schema.name, strict: true, schema: prompt.schema.schema },
					},
					// Only providers that honour the schema, and in production only those that
					// keep no data.
					provider: {
						require_parameters: true,
						...(denyDataCollection ? { data_collection: "deny" } : {}),
					},
					max_tokens: maxOutputTokens,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			// Fixed text: the library's message may carry the URL.
			const timedOut = error instanceof Error && error.name === "TimeoutError";
			return { kind: "retry", error: timedOut ? "timeout" : "network error" };
		}

		if (!res.ok) {
			// The provider's own message is never stored: it may echo the request.
			await res.body?.cancel().catch(() => undefined);
			return RETRYABLE.has(res.status)
				? { kind: "retry", error: `HTTP ${res.status}` }
				: { kind: "fail", reason: "provider_error", error: `HTTP ${res.status}` };
		}

		let body: ChatCompletion;
		try {
			body = (await res.json()) as ChatCompletion;
		} catch {
			return { kind: "retry", error: "unreadable response" };
		}
		const choice = body.choices?.[0];
		// OpenRouter can answer 200 with an error, when a provider failed mid-request.
		if (body.error || choice?.error || choice?.finish_reason === "error") {
			return { kind: "retry", error: "provider returned an error" };
		}
		if (choice?.finish_reason === "length") {
			return { kind: "fail", reason: "invalid_output", error: "output was cut off" };
		}
		const content = choice?.message?.content;
		if (typeof content !== "string" || content.trim() === "") {
			return { kind: "fail", reason: "invalid_output", error: "no output" };
		}
		return {
			kind: "ok",
			content,
			model: typeof body.model === "string" && body.model ? body.model.slice(0, 200) : model,
			inputTokens: count(body.usage?.prompt_tokens),
			outputTokens: count(body.usage?.completion_tokens),
		};
	},
});
