import { randomUUID } from "node:crypto";
import type { IncidentId } from "../../contract/incidents";
import type { IncidentRepository, IncidentService } from "../../domain/incidents/types";
import { canRespond } from "../../domain/shared/identity";
import { fail, ok } from "../../domain/shared/result";

export const createIncidentService = (
	repository: IncidentRepository,
	now: () => Date = () => new Date(),
): IncidentService => ({
	async create(principal, input) {
		if (!canRespond(principal)) {
			return fail("FORBIDDEN", "Your role cannot create incidents");
		}
		const incident = await repository.create(principal.tenantId, {
			id: randomUUID() as IncidentId,
			title: input.title,
			severity: input.severity,
			status: "open",
			createdAt: now(),
			createdBy: principal.userId,
		});
		return ok(incident);
	},

	async get(principal, id) {
		const incident = await repository.findById(principal.tenantId, id);
		return incident ? ok(incident) : fail("NOT_FOUND", "Incident not found");
	},

	async list(principal, page) {
		return ok(await repository.list(principal.tenantId, page));
	},
});
