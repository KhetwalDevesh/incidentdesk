import type { IncidentSeverity } from "../../contract/incidents";
import type {
	DeliveryActor,
	DeliveryPayload,
	NotificationEvent,
} from "../../domain/notifications/types";

// Spec: docs/features/slack-delivery.md, "Message".

// Slack mrkdwn treats only these three as control characters. Escaping them means untrusted
// text cannot form <!channel>, <!here>, <@U123> or <http://link|label>.
export const escapeMrkdwn = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const SEVERITY_ICONS: Record<IncidentSeverity, string> = {
	sev1: "🔴",
	sev2: "🟠",
	sev3: "🟡",
	sev4: "🔵",
};

const actorText = (actor: DeliveryActor) => {
	if (actor.type === "alert_source") return `alert source ${escapeMrkdwn(actor.name)}`;
	return actor.email === null ? "a removed member" : escapeMrkdwn(actor.email);
};

// 2m 39s, 1h 5m, 3d 2h, 45s.
export const formatDuration = (ms: number) => {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const [d, h, m, s] = [
		Math.floor(seconds / 86_400),
		Math.floor((seconds % 86_400) / 3600),
		Math.floor((seconds % 3600) / 60),
		seconds % 60,
	];
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

// The Slack incoming-webhook body for one delivery.
export const slackMessage = (
	event: NotificationEvent,
	incidentId: string,
	payload: DeliveryPayload,
): { text: string } => {
	const severity = payload.severity.toUpperCase();
	const title = escapeMrkdwn(payload.title);
	const actor = actorText(payload.actor);
	const reference = `incident ${incidentId.slice(0, 8)}`;
	const elapsed = formatDuration(Date.parse(payload.occurredAt) - Date.parse(payload.openedAt));

	if (event === "incident.opened") {
		const alerts =
			payload.actor.type === "alert_source" ? ` · ${plural(payload.alertCount, "alert")}` : "";
		return {
			text: `${SEVERITY_ICONS[payload.severity]} ${severity} incident opened: ${title}\nOpened by ${actor}${alerts} · ${reference}`,
		};
	}
	if (event === "incident.acknowledged") {
		return {
			text: `✅ ${severity} incident acknowledged: ${title}\nAcknowledged by ${actor} after ${elapsed} · ${reference}`,
		};
	}
	return {
		text: `🟢 ${severity} incident resolved: ${title}\nResolved by ${actor} after ${elapsed} · ${reference}`,
	};
};
