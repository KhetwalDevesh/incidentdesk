import type { Config } from "../config";
import { createApp } from "../http/app";
import { createDevTokenAuthenticator } from "../http/auth";
import { InMemoryIncidentRepository } from "../repository/incidents/inMemoryIncidentRepository";
import { createIncidentService } from "../services/incidents/incidentService";

// The composition root: the only place that picks a concrete repository.
export const buildApp = (config: Config) =>
	createApp({
		authenticate: createDevTokenAuthenticator(config.DEV_API_TOKENS),
		incidentService: createIncidentService(new InMemoryIncidentRepository()),
	});
