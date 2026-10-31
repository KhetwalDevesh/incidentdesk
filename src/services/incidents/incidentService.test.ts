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
