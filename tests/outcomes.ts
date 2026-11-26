import type { AlertSource, AlertSourceWriteOutcome } from "../src/domain/alerts/types";

// The source a create saved. Throws on a refusal, so a test that expects success fails loudly.
export const savedSource = (outcome: AlertSourceWriteOutcome): AlertSource => {
	if (outcome.status !== "saved") throw new Error(`alert source not saved: ${outcome.status}`);
	return outcome.source;
};
