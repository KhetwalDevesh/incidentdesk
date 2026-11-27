import { describe, expect, it } from "vitest";
import { renderPostmortem } from "./postmortemMarkdown";

// Spec: docs/features/ai-postmortems.md, "The postmortem document".

describe("renderPostmortem", () => {
	it("renders one heading per section, the timeline as a list, and the cause as a hypothesis", () => {
		expect(
			renderPostmortem({
				summary: "Checkout was slow.",
				impact: "EU customers, 20 minutes.",
				timeline: [
					{ at: "2026-01-10T02:10:00Z", event: "Opened by an alert" },
					{ at: "2026-01-10T02:30:00Z", event: "Resolved" },
				],
				suspectedCause: "The data suggests a bad deploy.",
				wentWell: ["Fast acknowledgement"],
				wentWrong: [],
				actionItems: ["Add a canary", "Alert on p99"],
			}),
		).toBe(
			[
				"## Summary",
				"Checkout was slow.",
				"## Impact",
				"EU customers, 20 minutes.",
				"## Timeline",
				"- 2026-01-10T02:10:00Z: Opened by an alert\n- 2026-01-10T02:30:00Z: Resolved",
				"## Suspected cause",
				"_A hypothesis drafted by AI. Confirm or correct it._",
				"The data suggests a bad deploy.",
				"## What went well",
				"- Fast acknowledgement",
				"## What went wrong",
				"_None noted._",
				"## Action items",
				"- [ ] Add a canary\n- [ ] Alert on p99",
			].join("\n\n"),
		);
	});

	it("stays within the body limit at the content schema's maximum sizes", () => {
		const max = (n: number) => "x".repeat(n);
		const body = renderPostmortem({
			summary: max(1000),
			impact: max(1000),
			timeline: Array.from({ length: 30 }, () => ({
				at: "2026-01-10T02:10:00.000+05:30",
				event: max(200),
			})),
			suspectedCause: max(1500),
			wentWell: Array.from({ length: 10 }, () => max(300)),
			wentWrong: Array.from({ length: 10 }, () => max(300)),
			actionItems: Array.from({ length: 10 }, () => max(300)),
		});

		expect(body.length).toBeLessThanOrEqual(20_000);
	});
});
