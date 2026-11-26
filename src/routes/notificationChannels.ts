import { Hono } from "hono";
import { PageQuerySchema } from "../contract/common";
import {
	CreateNotificationChannelRequestSchema,
	NotificationChannelIdSchema,
} from "../contract/notificationChannels";
import type { NotificationChannelService } from "../domain/notifications/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import {
	toNotificationChannelResponse,
	toNotificationDeliveryResponse,
} from "../mappers/notificationChannels";

export const notificationChannelRoutes = (service: NotificationChannelService) =>
	new Hono<AppEnv>()
		.get("/", async (c) => {
			const parsed = PageQuerySchema.safeParse(c.req.query());
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.list(c.get("principal"), parsed.data);
			return respond(c, result, ({ items, total }) =>
				c.json({ items: items.map(toNotificationChannelResponse), total, ...parsed.data }),
			);
		})
		.post("/", async (c) => {
			const parsed = CreateNotificationChannelRequestSchema.safeParse(
				await c.req.json().catch(() => null),
			);
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.create(c.get("principal"), parsed.data, {
				requestId: c.get("requestId"),
			});
			return respond(c, result, (channel) => c.json(toNotificationChannelResponse(channel), 201));
		})
		// Spec: docs/features/slack-delivery.md.
		.get("/:id/deliveries", async (c) => {
			const id = NotificationChannelIdSchema.safeParse(c.req.param("id"));
			if (!id.success) return problemResponse(c, validationError(id.error));
			const page = PageQuerySchema.safeParse(c.req.query());
			if (!page.success) return problemResponse(c, validationError(page.error));

			const result = await service.listDeliveries(c.get("principal"), id.data, page.data);
			return respond(c, result, ({ items, total }) =>
				c.json({ items: items.map(toNotificationDeliveryResponse), total, ...page.data }),
			);
		});
