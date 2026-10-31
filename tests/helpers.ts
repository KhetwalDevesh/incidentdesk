import { createApp } from "../src/http/app";
import { createDevTokenAuthenticator } from "../src/http/auth";
import { InMemoryIncidentRepository } from "../src/repository/incidents/inMemoryIncidentRepository";
import { createIncidentService } from "../src/services/incidents/incidentService";

export const buildTestApp = () =>
	createApp({
		authenticate: createDevTokenAuthenticator(
			"acme-responder:tenant-acme:user-1:responder,acme-viewer:tenant-acme:user-2:viewer,globex-responder:tenant-globex:user-3:responder",
		),
		incidentService: createIncidentService(new InMemoryIncidentRepository()),
	});

export const authed = (token: string, body?: unknown): RequestInit => ({
	method: body === undefined ? "GET" : "POST",
	headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
