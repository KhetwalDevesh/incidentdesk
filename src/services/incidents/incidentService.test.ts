import { describe, expect, it } from "vitest";
import { anAudit } from "../../../tests/auditEntries";
import type { User } from "../../domain/auth/types";
import type { IncidentRepository } from "../../domain/incidents/types";
import type { OnCallAssigner } from "../../domain/onCall/types";
import type { Principal, TenantId } from "../../domain/shared/identity";
import { InMemoryAccountRepository } from "../../repository/accounts/inMemoryAccountRepository";
import { InMemoryIncidentRepository } from "../../repository/incidents/inMemoryIncidentRepository";
import { createIncidentService } from "./incidentService";

const principal = (role: Principal["role"]): Principal => ({
	tenantId: "tenant-a" as TenantId,
	userId: "user-1",
	role,
});

// Grace (user-7) is on call. Spec: docs/features/on-call-schedules.md.
const graceOnCall: OnCallAssigner = {
	assigneeFor: async () => ({ userId: "user-7", email: "grace@acme.example" }),
};

const member = (id: string): User => ({
	id,
	tenantId: "tenant-a" as TenantId,
	email: `${id}@acme.example`,
	role: "responder",
	passwordHash: "x",
	createdAt: new Date(0),
});

// Every id is a member of tenant-a, with the email <id>@acme.example.
const members = {
	findUser: async (tenantId: TenantId, id: string) => (tenantId === "tenant-a" ? member(id) : null),
	findUsers: async (tenantId: TenantId, ids: string[]) =>
		tenantId === "tenant-a" ? ids.map(member) : [],
};

describe("incidentService.create", () => {
	const fixedNow = new Date("2026-01-01T00:00:00.000Z");
	const service = createIncidentService(new InMemoryIncidentRepository(), { now: () => fixedNow });
	const input = { title: "Checkout is down", severity: "sev1" } as const;

	it("opens an incident owned by the caller's tenant", async () => {
		const result = await service.create(principal("responder"), input);

		expect(result).toMatchObject({
			ok: true,
			value: { tenantId: "tenant-a", status: "open", createdBy: "user-1", createdAt: fixedNow },
		});
	});

	it("leaves the incident unassigned when nobody is on call", async () => {
		const result = await service.create(principal("responder"), input);

		expect(result).toMatchObject({ ok: true, value: { assigneeId: null, assignee: null } });
	});

	it("assigns the incident to whoever is on call", async () => {
		const assigned = createIncidentService(new InMemoryIncidentRepository(), {
			now: () => fixedNow,
			members,
			onCall: graceOnCall,
		});

		const result = await assigned.create(principal("responder"), input);

		expect(result).toMatchObject({
			ok: true,
			value: { assigneeId: "user-7", assignee: { id: "user-7", email: "user-7@acme.example" } },
		});
	});
});

describe("incidentService on an assigned incident", () => {
	const input = { title: "Checkout is down", severity: "sev1" } as const;

	const setup = async () => {
		// The caller (user-1) and Alan (user-8) are members the incident can be reassigned to.
		const accounts = new InMemoryAccountRepository();
		for (const id of ["user-1", "user-8"]) {
			await accounts.addUser(
				"tenant-a" as TenantId,
				member(id),
				{ tokenHash: `unused-${id}`, expiresAt: new Date(0) },
				anAudit("tenant-a" as TenantId, "member.invited"),
			);
		}
		const repository = new InMemoryIncidentRepository(accounts.audit, undefined, accounts);
		const service = createIncidentService(repository, { members, onCall: graceOnCall });
		const created = await service.create(principal("responder"), input);
		if (!created.ok) throw new Error("setup failed");
		return { repository, service, id: created.value.id };
	};

	it("refuses to let anyone but the assignee or an admin acknowledge or resolve it", async () => {
		const { service, id } = await setup();

		expect(await service.acknowledge(principal("responder"), id)).toMatchObject({
			ok: false,
			error: {
				code: "FORBIDDEN",
				detail: "Only the assignee or an admin can acknowledge this incident",
			},
		});
		expect(await service.resolve(principal("responder"), id)).toMatchObject({
			ok: false,
			error: {
				code: "FORBIDDEN",
				detail: "Only the assignee or an admin can resolve this incident",
			},
		});
	});

	it("lets the assignee act, and an admin step in", async () => {
		const { service, id } = await setup();

		expect(
			await service.acknowledge({ ...principal("responder"), userId: "user-7" }, id),
		).toMatchObject({ ok: true, value: { status: "acknowledged" } });
		expect(await service.resolve(principal("admin"), id)).toMatchObject({
			ok: true,
			value: { status: "resolved", resolvedBy: "user-1" },
		});
	});

	it("lets a responder take it by reassigning it to themself", async () => {
		const { service, id } = await setup();

		expect(await service.assign(principal("responder"), id, "user-1")).toMatchObject({
			ok: true,
			value: { assigneeId: "user-1", assignmentCount: 1 },
		});
		expect(await service.acknowledge(principal("responder"), id)).toMatchObject({ ok: true });
	});

	it("refuses an unassign by a responder", async () => {
		const { service, id } = await setup();

		const result = await service.assign(principal("responder"), id, null);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "FORBIDDEN", detail: "Only an admin can unassign an incident" },
		});
	});

	it("makes the old assignee's acknowledge lose to a reassignment between its read and write", async () => {
		const { repository, id } = await setup();
		const tenant = "tenant-a" as TenantId;
		// Real repository, except an admin moves the incident to Alan just before the write.
		const racing: IncidentRepository = {
			create: (...args) => repository.create(...args),
			findById: (...args) => repository.findById(...args),
			list: (...args) => repository.list(...args),
			reassign: (...args) => repository.reassign(...args),
			setSummary: (...args) => repository.setSummary(...args),
			update: async (...args) => {
				await repository.reassign(
					tenant,
					id,
					{ from: "user-7", to: "user-8" },
					anAudit(tenant, "incident.assigned"),
					{
						incidentId: id,
						event: "incident.reassigned",
						severity: "sev1",
						createdAt: new Date(),
						payload: {
							title: "Checkout is down",
							severity: "sev1",
							actor: { type: "user", email: null },
							alertCount: 0,
							openedAt: new Date().toISOString(),
							occurredAt: new Date().toISOString(),
						},
					},
				);
				return repository.update(...args);
			},
		};
		const raced = createIncidentService(racing, { members });

		const result = await raced.acknowledge({ ...principal("responder"), userId: "user-7" }, id);

		expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
		expect((await repository.findById(tenant, id))?.status).toBe("open");
	});
});

describe("incidentService.acknowledge", () => {
	const fixedNow = new Date("2026-01-01T00:00:00.000Z");
	const input = { title: "Checkout is down", severity: "sev1" } as const;

	const setup = async () => {
		const repository = new InMemoryIncidentRepository();
		const service = createIncidentService(repository, { now: () => fixedNow });
		const created = await service.create(principal("responder"), input);
		if (!created.ok) throw new Error("setup failed");
		return { repository, service, id: created.value.id };
	};

	it("records the time and the acknowledging user from the principal", async () => {
		const { service, id } = await setup();

		const result = await service.acknowledge({ ...principal("admin"), userId: "user-9" }, id);

		expect(result).toMatchObject({
			ok: true,
			value: { status: "acknowledged", acknowledgedAt: fixedNow, acknowledgedBy: "user-9" },
		});
	});

	it("hides another tenant's incident", async () => {
		const { service, id } = await setup();

		const result = await service.acknowledge(
			{ ...principal("responder"), tenantId: "tenant-b" as TenantId },
			id,
		);

		expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
	});

	it("refuses a resolved incident", async () => {
		const { repository, service, id } = await setup();
		await repository.update(
			"tenant-a" as TenantId,
			id,
			{ status: "open", assigneeId: null },
			{ status: "resolved" },
			anAudit("tenant-a" as TenantId, "incident.acknowledged"),
		);

		const result = await service.acknowledge(principal("responder"), id);

		expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
	});

	it("refuses a repeat acknowledge", async () => {
		const { service, id } = await setup();
		await service.acknowledge(principal("responder"), id);

		const result = await service.acknowledge(principal("admin"), id);

		expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
	});
});

describe("incidentService.resolve", () => {
	const fixedNow = new Date("2026-01-01T00:00:00.000Z");
	const input = { title: "Checkout is down", severity: "sev1" } as const;

	const setup = async () => {
		const repository = new InMemoryIncidentRepository();
		const service = createIncidentService(repository, { now: () => fixedNow });
		const created = await service.create(principal("responder"), input);
		if (!created.ok) throw new Error("setup failed");
		return { repository, service, id: created.value.id };
	};

	it("records the time and the resolving user from the principal", async () => {
		const { service, id } = await setup();

		const result = await service.resolve({ ...principal("admin"), userId: "user-9" }, id);

		expect(result).toMatchObject({
			ok: true,
			value: {
				status: "resolved",
				resolvedAt: fixedNow,
				resolvedBy: "user-9",
				acknowledgedAt: null,
			},
		});
	});

	it("resolves an acknowledged incident and keeps who acknowledged it", async () => {
		const { service, id } = await setup();
		await service.acknowledge({ ...principal("responder"), userId: "user-2" }, id);

		const result = await service.resolve({ ...principal("responder"), userId: "user-3" }, id);

		expect(result).toMatchObject({
			ok: true,
			value: { status: "resolved", acknowledgedBy: "user-2", resolvedBy: "user-3" },
		});
	});

	it("hides another tenant's incident", async () => {
		const { service, id } = await setup();

		const result = await service.resolve(
			{ ...principal("responder"), tenantId: "tenant-b" as TenantId },
			id,
		);

		expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
	});

	it("refuses a repeat resolve", async () => {
		const { service, id } = await setup();
		await service.resolve(principal("responder"), id);

		const result = await service.resolve(principal("admin"), id);

		expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
	});

	it("loses to an acknowledge that lands between its read and its write", async () => {
		const { repository, id } = await setup();
		const tenant = "tenant-a" as TenantId;
		// Real repository, except a teammate's acknowledge lands just before resolve writes.
		const racing: IncidentRepository = {
			create: (...args) => repository.create(...args),
			findById: (...args) => repository.findById(...args),
			list: (...args) => repository.list(...args),
			reassign: (...args) => repository.reassign(...args),
			setSummary: (...args) => repository.setSummary(...args),
			update: async (...args) => {
				await repository.update(
					tenant,
					id,
					{ status: "open", assigneeId: null },
					{ status: "acknowledged" },
					anAudit(tenant, "incident.acknowledged"),
				);
				return repository.update(...args);
			},
		};
		const raced = createIncidentService(racing, { now: () => fixedNow });

		const result = await raced.resolve(principal("responder"), id);

		expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
		expect((await repository.findById(tenant, id))?.status).toBe("acknowledged");
	});
});
