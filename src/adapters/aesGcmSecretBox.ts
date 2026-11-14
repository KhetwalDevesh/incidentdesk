import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretBox } from "../domain/notifications/types";

const ALGORITHM = "aes-256-gcm";
// Layout: version (1 byte) | nonce (12) | auth tag (16) | ciphertext.
// The version byte lets a later key or algorithm coexist with this one.
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES;

// keyBase64 must decode to exactly 32 bytes. Generate with: openssl rand -base64 32
export const createAesGcmSecretBox = (keyBase64: string): SecretBox => {
	const key = Buffer.from(keyBase64, "base64");
	if (key.length !== 32) throw new Error("Encryption key must be 32 bytes, base64-encoded");

	return {
		seal(plaintext, context) {
			const nonce = randomBytes(NONCE_BYTES);
			const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
			cipher.setAAD(Buffer.from(context, "utf8"));
			const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
			return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), body]);
		},

		open(sealed, context) {
			const bytes = Buffer.from(sealed);
			if (bytes.length < HEADER_BYTES || bytes[0] !== VERSION) {
				throw new Error("Unsupported ciphertext");
			}
			const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
			const tag = bytes.subarray(1 + NONCE_BYTES, HEADER_BYTES);
			const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
			decipher.setAAD(Buffer.from(context, "utf8"));
			decipher.setAuthTag(tag);
			// final() throws when the tag does not match: tampered data, wrong key or wrong context.
			return Buffer.concat([
				decipher.update(bytes.subarray(HEADER_BYTES)),
				decipher.final(),
			]).toString("utf8");
		},
	};
};
