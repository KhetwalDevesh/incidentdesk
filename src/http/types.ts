import type { Principal } from "../domain/shared/identity";

export type AppEnv = {
	Variables: {
		requestId: string;
		principal: Principal;
	};
};
