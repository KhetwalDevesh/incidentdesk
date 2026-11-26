import { SQSClient } from "@aws-sdk/client-sqs";
import { Pool } from "pg";
import { createAesGcmSecretBox } from "../adapters/aesGcmSecretBox";
import { createArgon2PasswordHasher } from "../adapters/argon2PasswordHasher";
import { createHmacAlertSignatureVerifier } from "../adapters/hmacAlertSignature";
import { createJwtTokenService } from "../adapters/jwtTokenService";
import { createSqsAlertQueue } from "../adapters/sqsAlertQueue";
import type { Config } from "../config";
import { createApp } from "../http/app";
import { PostgresAccountRepository } from "../repository/accounts/postgresAccountRepository";
import { PostgresAlertRepository } from "../repository/alerts/postgresAlertRepository";
import { PostgresAlertSourceRepository } from "../repository/alerts/postgresAlertSourceRepository";
import { PostgresAuditRepository } from "../repository/audit/postgresAuditRepository";
import { PostgresIncidentRepository } from "../repository/incidents/postgresIncidentRepository";
import { PostgresNotificationChannelRepository } from "../repository/notifications/postgresNotificationChannelRepository";
import { createAlertIngestService } from "../services/alerts/alertIngestService";
import { createAlertProcessor } from "../services/alerts/alertProcessor";
import { createAlertService } from "../services/alerts/alertService";
import { createAlertSourceService } from "../services/alerts/alertSourceService";
import { createAuditPurge } from "../services/audit/auditPurge";
import { createAuditService } from "../services/audit/auditService";
import { createAuthService } from "../services/auth/authService";
import { createIncidentService } from "../services/incidents/incidentService";
import { createMemberService } from "../services/members/memberService";
import { createNotificationChannelService } from "../services/notifications/notificationChannelService";

// The composition root: the only place that picks concrete repositories and adapters.

const buildAlertQueue = (config: Config) =>
	createSqsAlertQueue(
		new SQSClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL }),
		config.ALERT_QUEUE_URL,
	);

// Where the API reports failures it does not return to the caller. Ids only, never payloads.
export type AppErrorLog = {
	onAlertSendError: (alertId: string, error: unknown) => void;
	onAuditError: (entryId: string, error: unknown) => void;
};

export const buildApp = (config: Config, log: AppErrorLog) => {
	const pool = new Pool({ connectionString: config.DATABASE_URL });
	const accounts = new PostgresAccountRepository(pool);
	const audit = new PostgresAuditRepository(pool);
	const authService = createAuthService({
		credentials: accounts,
		accounts,
		hasher: createArgon2PasswordHasher(),
		tokens: createJwtTokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS),
		audit,
		onAuditError: log.onAuditError,
	});
	// One key for every stored secret. Each value is bound to its own context, so a
	// channel URL and a source secret can never be swapped.
	const secrets = createAesGcmSecretBox(config.NOTIFICATION_ENCRYPTION_KEY);
	const alertSources = new PostgresAlertSourceRepository(pool);
	const alerts = new PostgresAlertRepository(pool);
	const incidents = new PostgresIncidentRepository(pool);

	const app = createApp({
		authenticate: authService.authenticate,
		authService,
		incidentService: createIncidentService(incidents),
		memberService: createMemberService(accounts),
		notificationChannelService: createNotificationChannelService(
			new PostgresNotificationChannelRepository(pool),
			secrets,
		),
		alertSourceService: createAlertSourceService(alertSources, secrets),
		alertService: createAlertService(alerts),
		alertIngestService: createAlertIngestService({
			sources: alertSources,
			alerts,
			queue: buildAlertQueue(config),
			secrets,
			signatures: createHmacAlertSignatureVerifier(),
			onSendError: log.onAlertSendError,
		}),
		auditService: createAuditService(audit, incidents),
	});
	return { app, pool };
};

// The alert worker: turns queued alerts into incidents. See src/worker.ts.
export const buildWorker = (config: Config, onError: (subject: string, error: unknown) => void) => {
	const pool = new Pool({ connectionString: config.DATABASE_URL });
	const alerts = new PostgresAlertRepository(pool);
	const processor = createAlertProcessor({
		queue: buildAlertQueue(config),
		alerts,
		outbox: alerts,
		onError,
	});
	const purgeAudit = createAuditPurge({ purger: new PostgresAuditRepository(pool) });
	return { processor, purgeAudit, pool };
};
