// Reads a Server-Sent Events response from app.request, one event at a time.
export type ReceivedEvent = { event: string; data: unknown; retry: number | null };

type Requester = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

export const openStream = async (app: Requester, token: string, path = "/v1/events") => {
	const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } });
	const reader = res.body?.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const pending: ReceivedEvent[] = [];
	let ended = false;

	const parse = (block: string): ReceivedEvent | null => {
		let event = "message";
		let retry: number | null = null;
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith(":")) continue;
			const [field, ...rest] = line.split(":");
			const value = rest.join(":").replace(/^ /, "");
			if (field === "event") event = value;
			else if (field === "data") data.push(value);
			else if (field === "retry") retry = Number(value);
		}
		return data.length > 0 ? { event, data: JSON.parse(data.join("\n")), retry } : null;
	};

	// The next event, or null once the server closed the stream.
	const next = async (timeoutMs = 2000): Promise<ReceivedEvent | null> => {
		const deadline = Date.now() + timeoutMs;
		while (pending.length === 0) {
			if (ended || !reader) return null;
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`no event within ${timeoutMs} ms`);
			const chunk = await Promise.race([
				reader.read(),
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), left)),
			]);
			if (chunk === "timeout") throw new Error(`no event within ${timeoutMs} ms`);
			if (chunk.done) {
				ended = true;
				continue;
			}
			buffer += decoder.decode(chunk.value, { stream: true });
			let split = buffer.indexOf("\n\n");
			while (split !== -1) {
				const parsed = parse(buffer.slice(0, split));
				if (parsed) pending.push(parsed);
				buffer = buffer.slice(split + 2);
				split = buffer.indexOf("\n\n");
			}
		}
		return pending.shift() ?? null;
	};

	// Events until one named `name`, which is included.
	const until = async (name: string, timeoutMs = 2000) => {
		const seen: ReceivedEvent[] = [];
		for (;;) {
			const event = await next(timeoutMs);
			if (!event) throw new Error(`stream ended before ${name}`);
			seen.push(event);
			if (event.event === name) return seen;
		}
	};

	return { res, next, until, close: () => reader?.cancel() };
};
