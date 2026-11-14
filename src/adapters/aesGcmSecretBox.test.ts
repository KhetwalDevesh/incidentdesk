import { describe, expect, it } from "vitest";
import { createAesGcmSecretBox } from "./aesGcmSecretBox";

const key = Buffer.alloc(32, 7).toString("base64");
const box = createAesGcmSecretBox(key);
const URL = "https://hooks.slack.com/services/T000/B000/secret";

describe("aesGcmSecretBox", () => {
	it("opens what it sealed, under the same context", () => {
		expect(box.open(box.seal(URL, "ctx-a"), "ctx-a")).toBe(URL);
	});

	it("does not contain the plaintext", () => {
		expect(Buffer.from(box.seal(URL, "ctx-a")).includes(URL)).toBe(false);
	});

	it("uses a fresh nonce, so sealing twice gives different bytes", () => {
		expect(Buffer.from(box.seal(URL, "ctx-a"))).not.toEqual(Buffer.from(box.seal(URL, "ctx-a")));
	});

	it("refuses a different context, such as another tenant or channel", () => {
		const sealed = box.seal(URL, "ctx-a");

		expect(() => box.open(sealed, "ctx-b")).toThrow();
	});

	it("refuses tampered bytes", () => {
		const sealed = Buffer.from(box.seal(URL, "ctx-a"));
		sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;

		expect(() => box.open(sealed, "ctx-a")).toThrow();
	});

	it("refuses a different key", () => {
		const other = createAesGcmSecretBox(Buffer.alloc(32, 8).toString("base64"));

		expect(() => other.open(box.seal(URL, "ctx-a"), "ctx-a")).toThrow();
	});

	it("refuses an unknown version byte or a short value", () => {
		const sealed = Buffer.from(box.seal(URL, "ctx-a"));
		sealed[0] = 9;

		expect(() => box.open(sealed, "ctx-a")).toThrow("Unsupported ciphertext");
		expect(() => box.open(new Uint8Array(5), "ctx-a")).toThrow("Unsupported ciphertext");
	});

	it("rejects a key that is not 32 bytes", () => {
		expect(() => createAesGcmSecretBox(Buffer.alloc(16).toString("base64"))).toThrow();
	});
});
