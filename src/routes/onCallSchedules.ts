import { Hono } from "hono";
import { PageQuerySchema } from "../contract/common";
import {
	CreateOnCallOverrideRequestSchema,
	CreateOnCallScheduleRequestSchema,
	OnCallOverrideIdSchema,
	OnCallOverrideListQuerySchema,
	OnCallQuerySchema,
	OnCallScheduleIdSchema,
	UpdateOnCallScheduleRequestSchema,
} from "../contract/onCall";
import type { OnCallScheduleService } from "../domain/onCall/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import {
	toOnCallOverrideResponse,
	toOnCallResponse,
	toOnCallScheduleResponse,
} from "../mappers/onCall";

// Spec: docs/features/on-call-schedules.md

export const onCallScheduleRoutes = (service: OnCallScheduleService) =>
	new Hono<AppEnv>()
		.post("/", async (c) => {
			const parsed = CreateOnCallScheduleRequestSchema.safeParse(
				await c.req.json().catch(() => null),
			);
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.create(c.get("principal"), parsed.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (schedule) => {
				c.header("Location", `/v1/on-call-schedules/${schedule.id}`);
				return c.json(toOnCallScheduleResponse(schedule), 201);
			});
		})
		.get("/", async (c) => {
			const parsed = PageQuerySchema.safeParse(c.req.query());
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.list(c.get("principal"), parsed.data);
			return respond(c, result, ({ items, total }) =>
				c.json({ items: items.map(toOnCallScheduleResponse), total, ...parsed.data }),
			);
		})
		.get("/:id", async (c) => {
			const id = OnCallScheduleIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));

			const result = await service.get(c.get("principal"), id.data);
			return respond(c, result, (schedule) => c.json(toOnCallScheduleResponse(schedule)));
		})
		.patch("/:id", async (c) => {
			const id = OnCallScheduleIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const parsed = UpdateOnCallScheduleRequestSchema.safeParse(
				await c.req.json().catch(() => null),
			);
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.update(c.get("principal"), id.data, parsed.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (schedule) => c.json(toOnCallScheduleResponse(schedule)));
		})
		.delete("/:id", async (c) => {
			const id = OnCallScheduleIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));

			const result = await service.delete(c.get("principal"), id.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, () => c.body(null, 204));
		})
		.get("/:id/on-call", async (c) => {
			const id = OnCallScheduleIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const query = OnCallQuerySchema.safeParse(c.req.query());
			if (!query.success) return problemResponse(c, validationError(query.error));

			const at = query.data.at ? new Date(query.data.at) : null;
			const result = await service.onCall(c.get("principal"), id.data, at);
			return respond(c, result, (onCall) => c.json(toOnCallResponse(onCall)));
		})
		.post("/:id/overrides", async (c) => {
			const id = OnCallScheduleIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const parsed = CreateOnCallOverrideRequestSchema.safeParse(
				await c.req.json().catch(() => null),
			);
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.addOverride(c.get("principal"), id.data, parsed.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (override) => {
				c.header("Location", `/v1/on-call-schedules/${id.data}/overrides/${override.id}`);
				return c.json(toOnCallOverrideResponse(override), 201);
			});
		})
		.get("/:id/overrides", async (c) => {
			const id = OnCallScheduleIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const query = OnCallOverrideListQuerySchema.safeParse(c.req.query());
			if (!query.success) return problemResponse(c, validationError(query.error));

			const result = await service.listOverrides(c.get("principal"), id.data, query.data);
			return respond(c, result, ({ items, total }) =>
				c.json({
					items: items.map(toOnCallOverrideResponse),
					total,
					limit: query.data.limit,
					offset: query.data.offset,
				}),
			);
		})
		.delete("/:id/overrides/:overrideId", async (c) => {
			const id = OnCallScheduleIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const overrideId = OnCallOverrideIdSchema.safeParse(c.req.param("overrideId"));
			if (!overrideId.success) return problemResponse(c, validationError(overrideId.error));

			const result = await service.deleteOverride(c.get("principal"), id.data, overrideId.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, () => c.body(null, 204));
		});
