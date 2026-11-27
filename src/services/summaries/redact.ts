import type { AlertDetails } from "../../contract/alerts";

// Spec: docs/features/ai-summaries.md, "Prompt and untrusted data". Applied to everything
// sent to the model. A pattern match lowers the risk of a secret in alert text reaching the
// provider, but cannot rule it out.

export const REDACTED = "[redacted]";

// Detail keys whose values are credentials whatever they look like.
const SECRET_KEY =
	/passw(?:or)?d|pwd|secret|token|api[-_]?key|authori[sz]ation|cookie|session|private[-_]?key|credential/i;

// Applied in order: earlier patterns cover longer forms that later ones would split.
const PATTERNS: [RegExp, string][] = [
	// The credentials in a URL, keeping the scheme and host: https://user:pass@host.
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
	[/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
	// JWTs: three base64url segments, the first a JSON header.
	[/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
	// AWS access key ids.
	[/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
	// sk-… API keys (OpenAI, OpenRouter, Stripe and others).
	[/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED],
	// Long hex: digests, raw keys.
	[/\b[0-9a-f]{32,}\b/gi, REDACTED],
	// Long base64 with lower case, upper case and digits mixed, as random secrets are. Long
	// ordinary identifiers, such as service names, rarely mix all three.
	[
		/(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{32,}={0,2}/g,
		REDACTED,
	],
];

export const redactText = (text: string): string =>
	PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);

export const redactDetails = (details: AlertDetails): AlertDetails =>
	Object.fromEntries(
		Object.entries(details).map(([key, value]) => [
			key,
			SECRET_KEY.test(key) ? REDACTED : typeof value === "string" ? redactText(value) : value,
		]),
	);
