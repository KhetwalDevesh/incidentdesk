import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Violation = { check: string; file: string; message: string };
export type Baseline = Record<string, number>;

const ESCAPE_HATCH = /biome-ignore|@ts-ignore|@ts-expect-error|as unknown as/g;
const CLIENT_IDENTITY = /\b(?:body|json|query|param|params|input)\b[.(["']+tenantId\b/;
const INNER_LAYER = /^src\/(domain|services)\//;
const OUTER_IMPORT = /from\s+["'][^"']*\/(http|routes|repository|containers)\//;
const CONTRACT_ONLY = /^src\/contract\//;
const CONTRACT_FORBIDDEN = /from\s+["'][^"']*\/(domain|services|repository|http|routes)\//;

const isTest = (file: string) => file.endsWith(".test.ts");

// Each check has a case in enforce-rules.test.ts. Add both together.
export const checkFile = (file: string, source: string): Violation[] => {
	if (isTest(file)) return [];
	const violations: Violation[] = [];
	const add = (check: string, message: string) => violations.push({ check, file, message });

	if (file !== "src/config.ts" && source.includes("process.env")) {
		add("1-no-direct-env", "Read configuration through src/config.ts");
	}
	if (INNER_LAYER.test(file) && OUTER_IMPORT.test(source)) {
		add("2-layer-boundary", "domain and services cannot import outer layers");
	}
	if (CONTRACT_ONLY.test(file) && CONTRACT_FORBIDDEN.test(source)) {
		add("3-contract-isolation", "src/contract cannot import application code");
	}
	if (file.startsWith("src/routes/") && CLIENT_IDENTITY.test(source)) {
		add("4-no-client-identity", "tenantId comes only from the authenticated principal");
	}
	return violations;
};

export const countEscapeHatches = (source: string) => source.match(ESCAPE_HATCH)?.length ?? 0;

// Shrink-only: counts may fall, never rise, and a lower count must be recorded.
export const checkBaseline = (counts: Baseline, baseline: Baseline): Violation[] => {
	const check = "5-escape-hatch-ratchet";
	const violations: Violation[] = [];
	for (const [file, count] of Object.entries(counts)) {
		const allowed = baseline[file] ?? 0;
		if (count > allowed) {
			const message = `${count} escape hatches, ${allowed} allowed`;
			violations.push({ check, file, message });
		}
	}
	for (const [file, allowed] of Object.entries(baseline)) {
		if ((counts[file] ?? 0) < allowed) {
			const message = `Baseline is stale. Lower it to ${counts[file] ?? 0}`;
			violations.push({ check, file, message });
		}
	}
	return violations;
};

const sourceFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return path.endsWith(".ts") ? [path] : [];
	});

const main = () => {
	const baseline: Baseline = JSON.parse(readFileSync("scripts/escape-hatch-baseline.json", "utf8"));
	const counts: Baseline = {};
	const violations: Violation[] = [];

	for (const file of sourceFiles("src")) {
		const source = readFileSync(file, "utf8");
		violations.push(...checkFile(file, source));
		const count = isTest(file) ? 0 : countEscapeHatches(source);
		if (count > 0) counts[file] = count;
	}
	violations.push(...checkBaseline(counts, baseline));

	for (const { check, file, message } of violations) {
		console.error(`[${check}] ${file}: ${message}`);
	}
	if (violations.length > 0) process.exit(1);
	console.log("All project rules passed");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
