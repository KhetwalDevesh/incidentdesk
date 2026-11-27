import { describe, expect, it } from "vitest";
import { clientAddress, throttleIp } from "./clientIp";

// Spec: docs/features/login-rate-limiting.md, "The client IP".

describe("clientAddress", () => {
	it("uses the socket and ignores X-Forwarded-For when no proxy is trusted", () => {
		expect(clientAddress("203.0.113.9", "198.51.100.1", 0)).toBe("203.0.113.9");
	});

	it("reads the entry the trusted proxies wrote, counting from the right", () => {
		// The client wrote "1.1.1.1"; the edge proxy appended the real client, then an inner
		// proxy appended the edge.
		const header = "1.1.1.1, 198.51.100.7, 10.0.0.2";

		expect(clientAddress("10.0.0.3", header, 1)).toBe("10.0.0.2");
		expect(clientAddress("10.0.0.3", header, 2)).toBe("198.51.100.7");
	});

	it("never goes further left than the leftmost entry", () => {
		expect(clientAddress("10.0.0.3", "198.51.100.7", 5)).toBe("198.51.100.7");
	});

	it("falls back to the socket when a trusted proxy sent no header", () => {
		expect(clientAddress("10.0.0.3", undefined, 1)).toBe("10.0.0.3");
		expect(clientAddress("10.0.0.3", " , ", 1)).toBe("10.0.0.3");
	});
});

describe("throttleIp", () => {
	it.each([
		["IPv4", "203.0.113.9", "203.0.113.9"],
		["IPv4-mapped IPv6, as Node reports IPv4 clients", "::ffff:203.0.113.9", "203.0.113.9"],
		["IPv6, by its /64", "2001:db8:abcd:12:aaaa:bbbb:cccc:dddd", "2001:db8:abcd:12::/64"],
		["IPv6 with ::", "2001:db8::1", "2001:db8:0:0::/64"],
		["IPv6 with a zone", "fe80::1%eth0", "fe80:0:0:0::/64"],
		["IPv6 loopback", "::1", "0:0:0:0::/64"],
	])("keys %s", (_case, address, key) => {
		expect(throttleIp(address)).toBe(key);
	});

	it("puts every address of one /64 under one key", () => {
		expect(throttleIp("2001:db8:1:2:ffff::1")).toBe(throttleIp("2001:db8:1:2::9"));
		expect(throttleIp("2001:db8:1:3::1")).not.toBe(throttleIp("2001:db8:1:2::1"));
	});

	it.each([
		["nothing", undefined],
		["an empty string", ""],
		["a host name", "example.com"],
		["a forged header value", "<script>"],
	])("refuses %s", (_case, address) => {
		expect(throttleIp(address)).toBeNull();
	});
});
