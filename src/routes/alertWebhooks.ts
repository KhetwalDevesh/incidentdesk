import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
	ALERT_MAX_BODY_BYTES,
	ALERT_SIGNATURE_HEADER,
	ALERT_TIMESTAMP_HEADER,
	AlertPayloadSchema,
} from "../contract/alerts";
import type { AlertIngestService } from "../domain/alerts/types";
import { problemResponse, respond, validationError } from "../http/problem";
import type { AppEnv } from "../http/types";
import { toAlertAcceptedResponse } from "../mappers/alerts";

const parseJson = (bytes: Uint8Array): unknown => {
	try {
		return JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return null;
	}
};

// Public: authenticated by the source's HMAC signature, not a bearer token.
export const alertWebhookRoutes = (service: AlertIngestService) =>
	new Hono<AppEnv>().post(
		"/:sourceId",
		bodyLimit({
			maxSize: ALERT_MAX_BODY_BYTES,
			onError: (c) =>
				problemResponse(c, {
					code: "PAYLOAD_TOO_LARGE",
					detail: `The body is larger than ${ALERT_MAX_BODY_BYTES} bytes`,
				}),
		}),
		async (c) => {
			// The signature covers the raw bytes, so it is checked before anything is parsed.
			const rawBody = new Uint8Array(await c.req.arrayBuffer());
			const verified = await service.verify({
				sourceId: c.req.param("sourceId"),
				timestamp: c.req.header(ALERT_TIMESTAMP_HEADER),
				signature: c.req.header(ALERT_SIGNATURE_HEADER),
				rawBody,
			});
			if (!verified.ok) return problemResponse(c, verified.error);

			const parsed = AlertPayloadSchema.safeParse(parseJson(rawBody));
			if (!parsed.success) return problemResponse(c, validationError(parsed.error));

			const result = await service.enqueue(verified.value, parsed.data);
			return respond(c, result, (alert) => c.json(toAlertAcceptedResponse(alert), 202));
		},
	);
