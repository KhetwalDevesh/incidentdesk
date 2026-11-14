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
			acknowledgedAt: null,
			acknowledgedBy: null,
			resolvedAt: null,
			resolvedBy: null,
		});
		return ok(incident);
	},

	async acknowledge(principal, id) {
		if (!canRespond(principal)) {
			return fail("FORBIDDEN", "Your role cannot acknowledge incidents");
		}
		const incident = await repository.findById(principal.tenantId, id);
		if (!incident) return fail("NOT_FOUND", "Incident not found");
		if (incident.status !== "open") {
			return fail("CONFLICT", `Incident is ${incident.status}, not open`);
		}
		const updated = await repository.update(principal.tenantId, id, "open", {
			status: "acknowledged",
			acknowledgedAt: now(),
			acknowledgedBy: principal.userId,
		});
		// null means a concurrent request changed the status after our read.
		return updated ? ok(updated) : fail("CONFLICT", "Incident is no longer open");
	},

	async resolve(principal, id) {
		if (!canRespond(principal)) {
			return fail("FORBIDDEN", "Your role cannot resolve incidents");
		}
		const incident = await repository.findById(principal.tenantId, id);
		if (!incident) return fail("NOT_FOUND", "Incident not found");
		if (incident.status === "resolved") {
			return fail("CONFLICT", "Incident is already resolved");
		}
		// Expect the status we read, so a concurrent acknowledge or resolve makes this one lose.
		const updated = await repository.update(principal.tenantId, id, incident.status, {
			status: "resolved",
			resolvedAt: now(),
			resolvedBy: principal.userId,
		});
		return updated ? ok(updated) : fail("CONFLICT", "Incident changed while resolving");
	},

	async get(principal, id) {
		const incident = await repository.findById(principal.tenantId, id);
		return incident ? ok(incident) : fail("NOT_FOUND", "Incident not found");
	},

	async list(principal, page) {
		return ok(await repository.list(principal.tenantId, page));
	},
});
