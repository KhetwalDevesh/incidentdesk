import { describe, expect, it } from "vitest";
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
