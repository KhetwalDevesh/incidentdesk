import type { AlertRepository, AlertService } from "../../domain/alerts/types";
import { isAdmin } from "../../domain/shared/identity";
import { fail, ok } from "../../domain/shared/result";

export const createAlertService = (alerts: AlertRepository): AlertService => ({
	async list(principal, query) {
		if (!isAdmin(principal)) {
			return fail("FORBIDDEN", "Only admins can list alerts");
		}
		return ok(await alerts.list(principal.tenantId, query));
	},
});
