import type { PostmortemContent } from "../../contract/postmortems";

// Spec: docs/features/ai-postmortems.md, "The postmortem document". The text a member starts
// from when accepting a draft: one heading per section, the timeline as a list.

const points = (items: string[], marker = "-") =>
	items.length > 0 ? items.map((item) => `${marker} ${item}`).join("\n") : "_None noted._";

export const renderPostmortem = (content: PostmortemContent): string =>
	[
		"## Summary",
		content.summary,
		"## Impact",
		content.impact,
		"## Timeline",
		content.timeline.map((step) => `- ${step.at}: ${step.event}`).join("\n"),
		"## Suspected cause",
		"_A hypothesis drafted by AI. Confirm or correct it._",
		content.suspectedCause,
		"## What went well",
		points(content.wentWell),
		"## What went wrong",
		points(content.wentWrong),
		"## Action items",
		points(content.actionItems, "- [ ]"),
	].join("\n\n");
