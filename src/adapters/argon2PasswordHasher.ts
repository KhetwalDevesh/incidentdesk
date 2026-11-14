import { hash, verify } from "@node-rs/argon2";
import type { PasswordHasher } from "../domain/auth/types";

// argon2id with the library defaults (19 MiB, 2 passes), which match OWASP guidance.
// Tests pass cheaper costs to stay fast.
export const createArgon2PasswordHasher = (
	costs: { memoryCost?: number; timeCost?: number } = {},
): PasswordHasher => ({
	hash: (password) => hash(password, costs),
	// A malformed stored hash is a failed login, not a 500.
	verify: (passwordHash, password) => verify(passwordHash, password).catch(() => false),
});
