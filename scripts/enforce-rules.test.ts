import { describe, expect, it } from "vitest";
import { checkBaseline, checkFile, countEscapeHatches } from "./enforce-rules";

const checksFor = (file: string, source: string) =>
	checkFile(file, source).map((violation) => violation.check);

describe("checkFile", () => {
	it.each([
		["1-no-direct-env", "src/services/a.ts", "const x = process.env.KEY;"],
		["2-layer-boundary", "src/services/a.ts", 'import x from "../../repository/a/b";'],
		["2-layer-boundary", "src/domain/a/b.ts", 'import x from "../../http/app";'],
		["3-contract-isolation", "src/contract/a.ts", 'import x from "../domain/a/b";'],
		["4-no-client-identity", "src/routes/a.ts", "const id = body.tenantId;"],
		["4-no-client-identity", "src/routes/a.ts", 'const id = c.req.param("tenantId");'],
	])("flags %s in %s", (check, file, source) => {
		expect(checksFor(file, source)).toContain(check);
	});

	it.each([
		["config may read env", "src/config.ts", "process.env"],
		["services may import domain", "src/services/a.ts", 'import x from "../../domain/a/b";'],
		["identity from principal", "src/routes/a.ts", "principal.tenantId"],
		["tests are exempt", "src/services/a.test.ts", "process.env.KEY"],
	])("allows: %s", (_name, file, source) => {
		expect(checksFor(file, source)).toEqual([]);
	});
});

describe("checkBaseline", () => {
	const hatch = "x as unknown as Y; // @ts-expect-error";

	it("counts escape hatches", () => {
		expect(countEscapeHatches(hatch)).toBe(2);
	});

	it("flags a new escape hatch", () => {
		expect(checkBaseline({ "src/a.ts": 1 }, {})).toHaveLength(1);
	});

	it("flags a baseline that should have shrunk", () => {
		expect(checkBaseline({}, { "src/a.ts": 1 })).toHaveLength(1);
	});

	it("passes when counts match", () => {
		expect(checkBaseline({ "src/a.ts": 1 }, { "src/a.ts": 1 })).toEqual([]);
	});
});
