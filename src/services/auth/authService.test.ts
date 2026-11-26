import { describe, expect, it } from "vitest";
import type { AuditEntry, AuditRecorder } from "../../domain/audit/types";
import type { TokenService } from "../../domain/auth/types";
import type { TenantId } from "../../domain/shared/identity";
import { InMemoryAccountRepository } from "../../repository/accounts/inMemoryAccountRepository";
import { InMemoryAuditStore } from "../../repository/audit/inMemoryAuditStore";
import { createAuthService } from "./authService";

// Spec: docs/features/audit-log.md, "Sign-ins".
const PASSWORD = "correct horse battery";

const fakeTokens: TokenService = {
	issue: async () => ({ accessToken: "token", expiresIn: 3600 }),
	verify: async () => null,
};

// Fast and deterministic, since these tests are about recording, not hashing.
const plainHasher = {
	hash: async (password: string) => `hashed:${password}`,
	verify: async (hash: string, password: string) => hash === `hashed:${password}`,
};

const setup = async (audit: AuditRecorder, onAuditError?: (id: string) => void) => {
	const store = new InMemoryAuditStore();
	const accounts = new InMemoryAccountRepository(store);
	const service = createAuthService({
		credentials: accounts,
		accounts,
		hasher: plainHasher,
		tokens: fakeTokens,
		audit,
		onAuditError,
	});
	const signedUp = await service.signup({
		tenantName: "Acme",
		email: "ada@acme.example",
		password: PASSWORD,
	});
	expect(signedUp.ok).toBe(true);
	const user = await accounts.findUserByEmail("ada@acme.example");
	return { service, store, user };
};

describe("authService sign-in recording", () => {
	it("records a success and a failure for a known email, with no email or password", async () => {
		const recorded: AuditEntry[] = [];
		const { service, user } = await setup({ record: async (entry) => void recorded.push(entry) });

		await service.login({ email: "ada@acme.example", password: PASSWORD }, { requestId: "req-1" });
		await service.login({ email: "ada@acme.example", password: "wrong password here" });

		expect(recorded).toMatchObject([
			{
				tenantId: user?.tenantId,
				action: "user.login_succeeded",
				actor: { type: "user", id: user?.id },
				resource: { type: "user", id: user?.id },
				details: {},
				requestId: "req-1",
			},
			{
				action: "user.login_failed",
				actor: { type: "anonymous", id: null },
				resource: { type: "user", id: user?.id },
				details: {},
				requestId: null,
			},
		]);
		expect(JSON.stringify(recorded)).not.toContain("ada@acme.example");
		expect(JSON.stringify(recorded)).not.toContain("wrong password");
	});

	it("records nothing for an email no account has", async () => {
		const recorded: AuditEntry[] = [];
		const { service } = await setup({ record: async (entry) => void recorded.push(entry) });

		const result = await service.login({ email: "ghost@acme.example", password: PASSWORD });

		expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
		expect(recorded).toEqual([]);
	});

	it("never waits for the recording, so a stalled audit write cannot delay a login", async () => {
		const { service } = await setup({ record: () => new Promise(() => undefined) });

		const result = await service.login({ email: "ada@acme.example", password: PASSWORD });

		expect(result.ok).toBe(true);
	});

	it("never fails a login because recording failed, and reports the entry id only", async () => {
		const reported: string[] = [];
		const { service } = await setup(
			{ record: async () => Promise.reject(new Error("database is down")) },
			(id) => reported.push(id),
		);

		const result = await service.login({ email: "ada@acme.example", password: PASSWORD });
		await new Promise((resolve) => setImmediate(resolve));

		expect(result.ok).toBe(true);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("records the signup itself with the change, as tenant.created", async () => {
		const { store, user } = await setup({ record: async () => undefined });

		const { items } = await store.list(user?.tenantId as TenantId, {}, { limit: 10, offset: 0 });

		expect(items).toMatchObject([
			{
				action: "tenant.created",
				actor: { type: "user", id: user?.id },
				resource: { type: "tenant", id: user?.tenantId },
				details: { name: "Acme" },
			},
		]);
	});
});
