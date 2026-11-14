// A local webhook receiver for development and manual checks. It stands in for a Slack
// incoming webhook when there is no internet: point a notification channel's webhookUrl at it,
// watch what arrives, and switch how it answers to try out failure handling.
//
//   pnpm dev:receiver                       # http://127.0.0.1:4000, answers 200
//   pnpm dev:receiver --port 4100 --mode error
//
// Modes:
//   ok            answer 200
//   error         answer 500
//   reject        answer 404, as Slack does for a revoked webhook
//   hang          accept the request and never answer
//   fail-first:N  answer 500 to the first N deliveries, then 200
//
// While it runs:
//   GET /_mode/<mode>   switch mode, for example curl 127.0.0.1:4000/_mode/hang
//   GET /_received      every delivery so far, as JSON
import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";

export type Delivery = {
	n: number;
	at: string;
	method: string;
	path: string;
	contentType: string | null;
	body: string;
	answered: number | "none";
};

type Mode =
	| { kind: "ok" }
	| { kind: "error" }
	| { kind: "reject" }
	| { kind: "hang" }
	| { kind: "fail-first"; count: number };

export const parseMode = (value: string): Mode | null => {
	if (value === "ok" || value === "error" || value === "reject" || value === "hang") {
		return { kind: value };
	}
	const failFirst = /^fail-first:(\d+)$/.exec(value);
	if (failFirst?.[1] !== undefined) return { kind: "fail-first", count: Number(failFirst[1]) };
	return null;
};

const MODE_NAMES = "ok, error, reject, hang, fail-first:N";

const readBody = (req: IncomingMessage) =>
	new Promise<string>((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});

const statusFor = (mode: Mode, deliveryNumber: number): number | "none" => {
	switch (mode.kind) {
		case "ok":
			return 200;
		case "error":
			return 500;
		case "reject":
			return 404;
		case "hang":
			return "none";
		case "fail-first":
			return deliveryNumber <= mode.count ? 500 : 200;
	}
};

export const createReceiver = (options: {
	mode: string;
	log?: (line: string) => void;
}): { server: Server; received: Delivery[] } => {
	const log = options.log ?? (() => {});
	const initial = parseMode(options.mode);
	if (!initial) throw new Error(`Unknown mode "${options.mode}". Modes: ${MODE_NAMES}`);
	let mode = initial;
	let label = options.mode;
	// fail-first counts deliveries since the last mode switch, not since the process started.
	let sinceSwitch = 0;
	const received: Delivery[] = [];

	const server = createServer(async (req, res) => {
		const path = req.url ?? "/";

		if (req.method === "GET" && path.startsWith("/_mode/")) {
			const next = decodeURIComponent(path.slice("/_mode/".length));
			const parsed = parseMode(next);
			if (!parsed) {
				res.writeHead(400, { "content-type": "text/plain" }).end(`Modes: ${MODE_NAMES}\n`);
				return;
			}
			sinceSwitch = 0;
			mode = parsed;
			label = next;
			log(`mode -> ${label}`);
			res.writeHead(200, { "content-type": "text/plain" }).end(`mode ${label}\n`);
			return;
		}

		if (req.method === "GET" && path === "/_received") {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(received));
			return;
		}

		const body = await readBody(req);
		const n = received.length + 1;
		sinceSwitch += 1;
		const answered = statusFor(mode, sinceSwitch);
		received.push({
			n,
			at: new Date().toISOString(),
			method: req.method ?? "",
			path,
			contentType: req.headers["content-type"] ?? null,
			body,
			answered,
		});
		log(`#${n} ${req.method} ${path} -> ${answered === "none" ? "no answer (hang)" : answered}`);
		log(`   ${body}`);

		if (answered === "none") return;
		res.writeHead(answered, { "content-type": "text/plain" }).end(answered === 200 ? "ok" : "");
	});

	return { server, received };
};

const argValue = (args: string[], name: string) => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};

const main = () => {
	const args = process.argv.slice(2);
	const port = Number(argValue(args, "--port") ?? 4000);
	const modeArg = argValue(args, "--mode") ?? "ok";
	const { server } = createReceiver({ mode: modeArg, log: (line) => console.log(line) });
	server.listen(port, "127.0.0.1", () => {
		console.log(`Receiving on http://127.0.0.1:${port}/ (mode ${modeArg})`);
		console.log(`Switch mode: curl 127.0.0.1:${port}/_mode/<${MODE_NAMES}>`);
	});
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
