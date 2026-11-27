import { isIP } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./types";

// Spec: docs/features/login-rate-limiting.md, "The client IP".

// The address that sent the request. With no trusted proxies, the socket's peer. Behind
// `trustedHops` proxies, each appends the address it received from to X-Forwarded-For, so the
// client is that many entries from the right. Entries further left were written by the client
// and are never trusted.
export const clientAddress = (
	socketAddress: string | undefined,
	forwardedFor: string | undefined,
	trustedHops: number,
): string | undefined => {
	if (trustedHops <= 0) return socketAddress;
	const entries = (forwardedFor ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (entries.length === 0) return socketAddress;
	return entries[Math.max(0, entries.length - trustedHops)];
};

// The eight 16-bit groups of an IPv6 address, or null.
const ipv6Groups = (address: string): number[] | null => {
	const [head = "", tail] = address.split("::");
	const parse = (part: string) => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const piece of part.split(":")) {
			// An embedded IPv4 address, as in ::ffff:1.2.3.4, fills the last two groups.
			if (piece.includes(".")) {
				const octets = piece.split(".").map(Number);
				groups.push(
					((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
					((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
				);
			} else {
				groups.push(Number.parseInt(piece, 16));
			}
		}
		return groups;
	};
	const left = parse(head);
	const right = tail === undefined ? [] : parse(tail);
	const missing = 8 - left.length - right.length;
	if (missing < 0 || (tail === undefined && missing !== 0)) return null;
	return [...left, ...Array.from({ length: missing }, () => 0), ...right];
};

// How the throttle keys an address: IPv4 as itself, IPv4-mapped IPv6 as the IPv4 address, and
// any other IPv6 address by its /64 prefix, since one client usually holds a whole /64.
// Null for anything that is not an IP address.
export const throttleIp = (address: string | undefined): string | null => {
	if (!address) return null;
	const bare = address.split("%")[0] ?? "";
	if (isIP(bare) === 4) return bare;
	if (isIP(bare) !== 6) return null;
	const groups = ipv6Groups(bare.toLowerCase());
	if (!groups) return null;
	const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
	if (mapped) {
		const [high = 0, low = 0] = groups.slice(6);
		return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
	}
	return `${groups
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(":")}::/64`;
};

// Sets clientIp for the routes after it. In-process requests have no socket, so null.
export const clientIp =
	(trustedHops: number): MiddlewareHandler<AppEnv> =>
	async (c, next) => {
		let socketAddress: string | undefined;
		try {
			socketAddress = getConnInfo(c).remote.address;
		} catch {
			socketAddress = undefined;
		}
		c.set(
			"clientIp",
			throttleIp(clientAddress(socketAddress, c.req.header("X-Forwarded-For"), trustedHops)),
		);
		await next();
	};
