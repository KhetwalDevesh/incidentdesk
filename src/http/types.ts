import type { Principal } from "../domain/shared/identity";

export type AppEnv = {
	Variables: {
		requestId: string;
		principal: Principal;
		// Set on the public auth routes only. Spec: docs/features/login-rate-limiting.md.
		clientIp: string | null;
	};
};
