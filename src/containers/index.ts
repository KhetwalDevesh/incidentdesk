import { Pool } from "pg";
import type { Config } from "../config";
import { createApp } from "../http/app";
import { createDevTokenAuthenticator } from "../http/auth";
import { PostgresIncidentRepository } from "../repository/incidents/postgresIncidentRepository";
import { createIncidentService } from "../services/incidents/incidentService";

// The composition root: the only place that picks a concrete repository.
export const buildApp = (config: Config) => {
	const pool = new Pool({ connectionString: config.DATABASE_URL });
	const app = createApp({
		authenticate: createDevTokenAuthenticator(config.DEV_API_TOKENS),
		incidentService: createIncidentService(new PostgresIncidentRepository(pool)),
	});
	return { app, pool };
};
