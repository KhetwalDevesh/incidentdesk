import { describe, expect, it } from "vitest";
import { REDACTED, redactDetails, redactText } from "./redact";

// Spec: docs/features/ai-summaries.md, "Redaction first".

describe("redactText", () => {
	it.each([
		["an email", "paged ada@acme.example at 02:10", "paged [redacted] at 02:10"],
		["a bearer token", "Authorization: Bearer abc.def-123_xyz", "Authorization: Bearer [redacted]"],
		[
			"a JWT",
			"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U seen",
			"token [redacted] seen",
		],
		["an AWS key id", "key AKIAIOSFODNN7EXAMPLE leaked", "key [redacted] leaked"],
		["an sk- API key", "OPENROUTER sk-or-v1-0123456789abcdefABCDEF", "OPENROUTER [redacted]"],
		[
			"credentials in a URL",
			"connect postgres://app:hunter2@db.internal:5432/main failed",
			"connect postgres://[redacted]@db.internal:5432/main failed",
		],
		[
			"a long hex secret",
			"digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
			"digest [redacted]",
		],
		[
			"a random base64 secret",
			"secret dGhpc0lzQVZlcnlMb25nU2VjcmV0S2V5MTIzNDU2Nzg5 here",
			"secret [redacted] here",
		],
	])("removes %s", (_case, input, output) => {
		expect(redactText(input)).toBe(output);
	});

	it.each([
		"Checkout API p99 latency above 2s in eu-west-1",
		"checkout-service-production-eu-west-1-cluster is unhealthy",
		"Disk usage 93% on db-primary-3 since 02:10 UTC",
		"incident 7c9e6679-7425-40de-944b-e07fc1f90ae7 grouped 12 alerts",
	])("leaves ordinary text alone: %s", (text) => {
		expect(redactText(text)).toBe(text);
	});
});

describe("redactDetails", () => {
	it("blanks credential-like keys whatever their value, and redacts the rest by pattern", () => {
		expect(
			redactDetails({
				password: "x",
				DB_PASSWD: "short",
				mysql_pwd: "x",
				api_key: 12345,
				"X-Auth-Token": "abc",
				Authorization: "Basic Zm9vOmJhcg==",
				session_id: "s1",
				owner: "grace@acme.example",
				region: "eu-west-1",
				cpu: 93,
				paging: true,
			}),
		).toEqual({
			password: REDACTED,
			DB_PASSWD: REDACTED,
			mysql_pwd: REDACTED,
			api_key: REDACTED,
			"X-Auth-Token": REDACTED,
			Authorization: REDACTED,
			session_id: REDACTED,
			owner: REDACTED,
			region: "eu-west-1",
			cpu: 93,
			paging: true,
		});
	});
});
