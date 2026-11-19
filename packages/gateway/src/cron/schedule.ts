import { Cron } from "croner";

export type Schedule =
	| { kind: "interval"; intervalMs: number }
	| { kind: "once"; runAt: number }
	| { kind: "cron"; expr: string };

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const MINUTE_MS = 60_000;
const MIN_GRACE_MS = 120_000;
const MAX_GRACE_MS = 2 * 3_600_000;

const UNRECOGNIZED =
	'Unrecognized schedule. Use 30m / 2h / 1d, "in 30m", a 5-field cron expression, or an ISO timestamp.';

function durationMs(count: string, unit: string): number {
	return Number(count) * (UNIT_MS[unit] ?? MINUTE_MS);
}

/**
 * Parse a schedule expression.
 *
 * Accepted forms: `30m` / `2h` / `1d` (repeat every duration), `in 30m` (run once),
 * a 5-field cron expression, or an ISO timestamp later than `now`.
 */
export function parseSchedule(input: string, now: Date, timezone?: string): Schedule {
	const text = input.trim();
	const interval = /^(\d+)(m|h|d)$/.exec(text);
	if (interval) {
		const intervalMs = durationMs(interval[1], interval[2]);
		if (intervalMs < MINUTE_MS) throw new Error("Interval must be at least 1 minute.");
		return { kind: "interval", intervalMs };
	}

	const once = /^in (\d+)(m|h|d)$/.exec(text);
	if (once) return { kind: "once", runAt: now.getTime() + durationMs(once[1], once[2]) };

	if (/^[\d*/,\-A-Za-z]+( [\d*/,\-A-Za-z]+){4}$/.test(text)) {
		try {
			new Cron(text, { timezone, paused: true });
		} catch (error) {
			throw new Error(`Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { kind: "cron", expr: text };
	}

	const runAt = Date.parse(text);
	if (!Number.isNaN(runAt)) {
		if (runAt <= now.getTime()) throw new Error("The timestamp must be in the future.");
		return { kind: "once", runAt };
	}

	throw new Error(UNRECOGNIZED);
}

/** The next run after `after`, or undefined when a one-off has already run. */
export function nextRun(schedule: Schedule, after: Date, timezone?: string): number | undefined {
	if (schedule.kind === "interval") return after.getTime() + schedule.intervalMs;
	if (schedule.kind === "once") return schedule.runAt > after.getTime() ? schedule.runAt : undefined;
	return new Cron(schedule.expr, { timezone, paused: true }).nextRun(after)?.getTime();
}

/**
 * How late a run may start and still run. A run later than this is recorded as missed instead, so
 * a daemon that was down for a day does not replay every interval.
 */
export function graceMs(schedule: Schedule, after: Date = new Date(), timezone?: string): number {
	let grace: number;
	if (schedule.kind === "interval") {
		grace = schedule.intervalMs / 2;
	} else if (schedule.kind === "once") {
		grace = MIN_GRACE_MS;
	} else {
		const first = nextRun(schedule, after, timezone);
		const second = first === undefined ? undefined : nextRun(schedule, new Date(first), timezone);
		grace = first !== undefined && second !== undefined ? (second - first) / 2 : MIN_GRACE_MS;
	}
	return Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, grace));
}
