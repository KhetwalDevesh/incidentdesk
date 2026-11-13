import { Pool } from "pg";
import { createArgon2PasswordHasher } from "../adapters/argon2PasswordHasher";
import { createJwtTokenService } from "../adapters/jwtTokenService";
import type { Config } from "../config";
import { createApp } from "../http/app";
import { PostgresAccountRepository } from "../repository/accounts/postgresAccountRepository";
import { PostgresIncidentRepository } from "../repository/incidents/postgresIncidentRepository";
import { createAuthService } from "../services/auth/authService";
import { createIncidentService } from "../services/incidents/incidentService";
import { createMemberService } from "../services/members/memberService";

// The composition root: the only place that picks concrete repositories and adapters.
export const buildApp = (config: Config) => {
	const pool = new Pool({ connectionString: config.DATABASE_URL });
	const accounts = new PostgresAccountRepository(pool);
	const authService = createAuthService({
		credentials: accounts,
		accounts,
		hasher: createArgon2PasswordHasher(),
		tokens: createJwtTokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS),
	});

	const app = createApp({
		authenticate: authService.authenticate,
		authService,
		incidentService: createIncidentService(new PostgresIncidentRepository(pool)),
		memberService: createMemberService(accounts),
	});
	return { app, pool };
};
