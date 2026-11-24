import { createHmac, timingSafeEqual } from "node:crypto";
import type { AlertSignatureVerifier } from "../domain/alerts/types";

const PREFIX = "v1=";
const HEX_SHA256 = /^[0-9a-f]{64}$/;

const digest = (secret: string, timestamp: string, rawBody: Uint8Array) =>
	createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();

// What a monitoring tool sends in X-IncidentDesk-Signature. Used by tests and the docs example.
export const signAlertBody = (secret: string, timestamp: string, rawBody: Uint8Array | string) =>
	`${PREFIX}${digest(secret, timestamp, typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody).toString("hex")}`;

// HMAC-SHA256 over `{timestamp}.{raw body bytes}`, compared in constant time.
export const createHmacAlertSignatureVerifier = (): AlertSignatureVerifier => ({
	verify(secret, timestamp, rawBody, signature) {
		if (!signature.startsWith(PREFIX)) return false;
		const hex = signature.slice(PREFIX.length);
		// The length check also keeps timingSafeEqual from throwing on a short input.
		if (!HEX_SHA256.test(hex)) return false;
		return timingSafeEqual(Buffer.from(hex, "hex"), digest(secret, timestamp, rawBody));
	},
});
