import { describe, expect, it } from "vitest";
import type { IncidentRepository } from "../../domain/incidents/types";
import type { Principal, TenantId } from "../../domain/shared/identity";
import { InMemoryIncidentRepository } from "../../repository/incidents/inMemoryIncidentRepository";
import { createIncidentService } from "./incidentService";

const principal = (role: Principal["role"]): Principal => ({
	tenantId: "tenant-a" as TenantId,
	userId: "user-1",
	role,
});

describe("incidentService.create", () => {
	const fixedNow = new Date("2026-01-01T00:00:00.000Z");
	const service = createIncidentService(new InMemoryIncidentRepository(), () => fixedNow);
	const input = { title: "Checkout is down", severity: "sev1" } as const;

	it("opens an incident owned by the caller's tenant", async () => {
		const result = await service.create(principal("responder"), input);

		expect(result).toMatchObject({
			ok: true,
			value: { tenantId: "tenant-a", status: "open", createdBy: "user-1", createdAt: fixedNow },
		});
	});

	it("refuses a viewer", async () => {
		const result = await service.create(principal("viewer"), input);

		expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
	});
});

describe("incidentService.acknowledge", () => {
	const fixedNow = new Date("2026-01-01T00:00:00.000Z");
	const input = { title: "Checkout is down", severity: "sev1" } as const;

	const setup = async () => {
		const repository = new InMemoryIncidentRepository();
		const service = createIncidentService(repository, () => fixedNow);
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

	it("refuses a viewer", async () => {
		const { service, id } = await setup();

		const result = await service.acknowledge(principal("viewer"), id);

		expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
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
		await repository.update("tenant-a" as TenantId, id, "open", { status: "resolved" });

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
		const service = createIncidentService(repository, () => fixedNow);
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

	it("refuses a viewer", async () => {
		const { service, id } = await setup();

		const result = await service.resolve(principal("viewer"), id);

		expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
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
			update: async (...args) => {
				await repository.update(tenant, id, "open", { status: "acknowledged" });
				return repository.update(...args);
			},
		};
		const raced = createIncidentService(racing, () => fixedNow);

		const result = await raced.resolve(principal("responder"), id);

		expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
		expect((await repository.findById(tenant, id))?.status).toBe("acknowledged");
	});
});
