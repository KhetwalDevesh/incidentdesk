import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { buildOpenApiDocument } from "../src/contract/openapi";

const OUTPUT = "contracts/openapi.yaml";
const header = "# Generated from src/contract by `pnpm contract:generate`. Do not edit.\n";
const generated = header + stringify(buildOpenApiDocument());

if (process.argv.includes("--check")) {
	const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
	if (current !== generated) {
		console.error(`${OUTPUT} is out of date. Run: pnpm contract:generate`);
		process.exit(1);
	}
	console.log(`${OUTPUT} is up to date`);
} else {
	writeFileSync(OUTPUT, generated);
	console.log(`Wrote ${OUTPUT}`);
}
