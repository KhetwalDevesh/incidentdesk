import { randomBytes, randomUUID } from "node:crypto";
import {
	type AlertSourceRepository,
	type AlertSourceService,
	type AlertSourceWriteOutcome,
	alertSourceSecretContext,
} from "../../domain/alerts/types";
import { auditEntry, auditOrigin } from "../../domain/audit/types";
import type { SecretBox } from "../../domain/notifications/types";
import { isAdmin } from "../../domain/shared/identity";
import { fail, ok, type Result } from "../../domain/shared/result";

const HINT_LENGTH = 4;
const SECRET_BYTES = 32;

// Turns a refused write into the problem the API returns.
const refused = (outcome: Exclude<AlertSourceWriteOutcome, { status: "saved" }>): Result<never> => {
	switch (outcome.status) {
		case "not_found":
			return fail("NOT_FOUND", "Alert source not found");
		case "name_taken":
			return fail("CONFLICT", "An alert source with this name already exists");
		case "schedule_not_found":
			return {
				ok: false,
				error: {
					code: "NOT_FOUND",
					detail: "On-call schedule not found",
					errors: [{ path: "onCallScheduleId", message: "On-call schedule not found" }],
				},
			};
	}
};

export const createAlertSourceService = (
	sources: AlertSourceRepository,
	secrets: SecretBox,
	now: () => Date = () => new Date(),
): AlertSourceService => ({
	async list(principal, page) {
		if (!isAdmin(principal)) {
			return fail("FORBIDDEN", "Only admins can list alert sources");
		}
		return ok(await sources.list(principal.tenantId, page));
	},

	async create(principal, { name, onCallScheduleId }, context) {
		if (!isAdmin(principal)) {
			return fail("FORBIDDEN", "Only admins can add alert sources");
		}
		const id = randomUUID();
		const secret = randomBytes(SECRET_BYTES).toString("base64url");
		const createdAt = now();
		const outcome = await sources.create(
			principal.tenantId,
			{
				id,
				name,
				secretCiphertext: secrets.seal(secret, alertSourceSecretContext(principal.tenantId, id)),
				secretHint: secret.slice(-HINT_LENGTH),
				onCallScheduleId,
				createdAt,
			},
			// The name only: never the secret or its hint.
			auditEntry(
				auditOrigin(createdAt, context),
				principal.tenantId,
				"alert_source.created",
				{ type: "user", id: principal.userId },
				{ type: "alert_source", id },
				{ name },
			),
		);
		if (outcome.status !== "saved") return refused(outcome);
		// The only time the plaintext secret leaves the service.
		return ok({ source: outcome.source, secret });
	},

	// Spec: docs/features/on-call-schedules.md.
	async update(principal, id, { onCallScheduleId }, context) {
		if (!isAdmin(principal)) {
			return fail("FORBIDDEN", "Only admins can change alert sources");
		}
		const outcome = await sources.link(
			principal.tenantId,
			id,
			onCallScheduleId,
			auditEntry(
				auditOrigin(now(), context),
				principal.tenantId,
				"alert_source.updated",
				{ type: "user", id: principal.userId },
				{ type: "alert_source", id },
				{ onCallScheduleId: onCallScheduleId ?? "none" },
			),
		);
		return outcome.status === "saved" ? ok(outcome.source) : refused(outcome);
	},
});
