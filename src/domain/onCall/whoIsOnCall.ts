import type { OnCallOverride, OnCallSchedule, OnCallShift } from "./types";

// Spec: docs/features/on-call-schedules.md, "Who is on call at a time".
// Node 22 has no Temporal, so local times are worked out with Intl.

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string) => {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
};

// The local wall-clock time at an instant, as if it were UTC: comparable with Date.UTC values.
const wallClock = (instant: number, timeZone: string) => {
	const parts: Record<string, number> = {};
	for (const part of formatterFor(timeZone).formatToParts(instant)) {
		if (part.type !== "literal") parts[part.type] = Number(part.value);
	}
	return Date.UTC(
		parts.year ?? 0,
		(parts.month ?? 1) - 1,
		parts.day ?? 1,
		parts.hour ?? 0,
		parts.minute ?? 0,
		parts.second ?? 0,
	);
};

const offsetAt = (instant: number, timeZone: string) => wallClock(instant, timeZone) - instant;

// The instant a local wall-clock time happens. When it happens twice (clocks go back), the
// first. When it never happens (clocks go forward past it), the first valid time after it.
export const localInstant = (wall: number, timeZone: string): number => {
	// Zones change offset at most once in a few weeks, so a day either side brackets it.
	const candidates = [
		wall - offsetAt(wall - DAY_MS, timeZone),
		wall - offsetAt(wall + DAY_MS, timeZone),
	];
	const valid = candidates.filter((instant) => wallClock(instant, timeZone) === wall);
	if (valid.length > 0) return Math.min(...valid);

	// A skipped time. Binary search, by minute, for the first instant whose local time is later.
	let low = Math.min(...candidates);
	let high = Math.max(...candidates);
	while (high - low > MINUTE_MS) {
		const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
		if (wallClock(middle, timeZone) >= wall) high = middle;
		else low = middle;
	}
	return high;
};

// When shift k starts: the handover time on startsOn plus k rotations, in the schedule's zone.
const shiftStart = (schedule: OnCallSchedule, k: number) => {
	const [year, month, day] = schedule.startsOn.split("-").map(Number) as [number, number, number];
	const [hour, minute] = schedule.handoffTime.split(":").map(Number) as [number, number];
	return localInstant(
		Date.UTC(year, month - 1, day + k * schedule.rotationDays, hour, minute),
		schedule.timeZone,
	);
};

// The shift running at `at`: its number and bounds. Null before the rotation starts.
export const shiftAt = (schedule: OnCallSchedule, at: number) => {
	const first = shiftStart(schedule, 0);
	if (at < first) return null;
	// An estimate, off by at most one either way after daylight saving changes.
	let k = Math.floor((at - first) / (schedule.rotationDays * DAY_MS));
	while (k > 0 && shiftStart(schedule, k) > at) k -= 1;
	while (shiftStart(schedule, k + 1) <= at) k += 1;
	return { k, from: shiftStart(schedule, k), until: shiftStart(schedule, k + 1) };
};

// Who is on call at `at`. `overrides` are the schedule's overrides ending after `at`, by start
// time; at most one covers `at`, since overrides never overlap.
export const whoIsOnCall = (
	schedule: OnCallSchedule,
	overrides: OnCallOverride[],
	at: Date,
): OnCallShift | null => {
	const now = at.getTime();
	const covering = overrides.find(
		(override) => override.startsAt.getTime() <= now && now < override.endsAt.getTime(),
	);
	if (covering) {
		return {
			userId: covering.userId,
			email: covering.email,
			source: "override",
			from: covering.startsAt,
			until: covering.endsAt,
		};
	}

	const { participants } = schedule;
	if (participants.length === 0) return null;
	const shift = shiftAt(schedule, now);
	if (!shift) return null;
	const member = participants[shift.k % participants.length];
	if (!member) return null;
	// The rotation hands over at the next handover, or earlier if an override starts first.
	const nextOverride = overrides.find((override) => override.startsAt.getTime() > now);
	const until = Math.min(shift.until, nextOverride?.startsAt.getTime() ?? Number.POSITIVE_INFINITY);
	return {
		userId: member.userId,
		email: member.email,
		source: "rotation",
		from: new Date(shift.from),
		until: new Date(until),
	};
};
