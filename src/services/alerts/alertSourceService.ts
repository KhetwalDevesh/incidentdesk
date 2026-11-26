import { randomBytes, randomUUID } from "node:crypto";
import {
	type AlertSourceRepository,
	type AlertSourceService,
	alertSourceSecretContext,
} from "../../domain/alerts/types";
import { auditEntry, auditOrigin } from "../../domain/audit/types";
import type { SecretBox } from "../../domain/notifications/types";
import { isAdmin } from "../../domain/shared/identity";
import { fail, ok } from "../../domain/shared/result";

const HINT_LENGTH = 4;
const SECRET_BYTES = 32;

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

	async create(principal, { name }, context) {
		if (!isAdmin(principal)) {
			return fail("FORBIDDEN", "Only admins can add alert sources");
		}
		const id = randomUUID();
		const secret = randomBytes(SECRET_BYTES).toString("base64url");
		const createdAt = now();
		const source = await sources.create(
			principal.tenantId,
			{
				id,
				name,
				secretCiphertext: secrets.seal(secret, alertSourceSecretContext(principal.tenantId, id)),
				secretHint: secret.slice(-HINT_LENGTH),
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
		if (!source) return fail("CONFLICT", "An alert source with this name already exists");
		// The only time the plaintext secret leaves the service.
		return ok({ source, secret });
	},
});
