import { z } from "zod";
import { INCIDENT_SEVERITIES } from "./incidents";

// Spec: docs/features/dashboard-stats.md

export const MAX_DASHBOARD_WINDOW_DAYS = 90;
export const MAX_DASHBOARD_WINDOW_MS = MAX_DASHBOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const MAX_DASHBOARD_LOAD_ROWS = 100;

// Both or neither. When given, every number counts only incidents opened at or after `from`
// and before `to`.
export const DashboardQuerySchema = z
	.object({
		from: z.iso.datetime({ offset: true }).optional(),
		to: z.iso.datetime({ offset: true }).optional(),
	})
	.superRefine(({ from, to }, ctx) => {
		if (from === undefined && to === undefined) return;
		if (from === undefined || to === undefined) {
			ctx.addIssue({
				code: "custom",
				path: [from === undefined ? "from" : "to"],
				message: "Give both from and to, or neither",
			});
			return;
		}
		const span = Date.parse(to) - Date.parse(from);
		if (span <= 0) {
			ctx.addIssue({ code: "custom", path: ["from"], message: "Must be before to" });
		} else if (span > MAX_DASHBOARD_WINDOW_MS) {
			ctx.addIssue({
				code: "custom",
				path: ["to"],
				message: `At most ${MAX_DASHBOARD_WINDOW_DAYS} days after from`,
			});
		}
	});

export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

const StatusCountsSchema = z.strictObject({
	open: z.number().int(),
	acknowledged: z.number().int(),
});

// Strict so a leaked internal field, such as tenantId, fails the contract test.
export const DashboardSchema = z
	.strictObject({
		generatedAt: z.iso.datetime(),
		window: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }).nullable(),
		totals: z.strictObject({
			open: z.number().int(),
			acknowledged: z.number().int(),
			unassigned: z.number().int(),
		}),
		bySeverity: z.strictObject(
			Object.fromEntries(
				INCIDENT_SEVERITIES.map((severity) => [severity, StatusCountsSchema]),
			) as Record<(typeof INCIDENT_SEVERITIES)[number], typeof StatusCountsSchema>,
		),
		// Members holding at least one unresolved incident, most loaded first. At most 100.
		load: z.array(
			z.strictObject({
				userId: z.uuid(),
				email: z.string(),
				open: z.number().int(),
				acknowledged: z.number().int(),
				total: z.number().int(),
			}),
		),
		// How many members hold unresolved incidents, which may exceed load's length.
		assigneeCount: z.number().int(),
	})
	.openapi("Dashboard", {
		description: "Unresolved incidents, read now, optionally narrowed to those opened in a window.",
	});

export type DashboardResponse = z.infer<typeof DashboardSchema>;
