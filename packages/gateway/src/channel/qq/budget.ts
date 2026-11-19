/** Replies one inbound QQ message may receive inside its passive window. */
export const PASSIVE_REPLY_LIMIT = 4;

/** How long a passive reply window stays open after the message arrives. */
export const PASSIVE_WINDOW_MS = 60 * 60_000;

const MINUTE_MS = 60_000;

export interface PassiveBudgetOptions {
	/** Replies per inbound message; defaults to `PASSIVE_REPLY_LIMIT`. */
	limit?: number;
	/** Window length in milliseconds; defaults to `PASSIVE_WINDOW_MS`. */
	windowMs?: number;
}

interface PassiveEntry {
	receivedAt: number;
	used: number;
}

/**
 * Tracks the passive reply slots of inbound messages.
 *
 * QQ lets a bot answer one inbound C2C message a handful of times inside an hour, each answer
 * carrying the source `msg_id` and a 1-based `msg_seq`. The budget is per inbound message and
 * never resets: once the window closes or the slots run out, further replies have to be proactive.
 */
export class PassiveBudget {
	private readonly limit: number;
	private readonly windowMs: number;
	private readonly entries = new Map<string, PassiveEntry>();

	constructor(options: PassiveBudgetOptions = {}) {
		this.limit = options.limit ?? PASSIVE_REPLY_LIMIT;
		this.windowMs = options.windowMs ?? PASSIVE_WINDOW_MS;
	}

	/** Start the window of an inbound message, so it counts from delivery rather than first use. */
	register(messageId: string, now: number): void {
		if (!this.entries.has(messageId)) this.entries.set(messageId, { receivedAt: now, used: 0 });
		this.prune(now);
	}

	/** Next `msg_seq` for a passive reply, or undefined when the window is closed or full. */
	takePassive(messageId: string, now: number): number | undefined {
		const entry = this.entries.get(messageId) ?? { receivedAt: now, used: 0 };
		if (now - entry.receivedAt >= this.windowMs) return undefined;
		if (entry.used >= this.limit) return undefined;
		entry.used += 1;
		this.entries.set(messageId, entry);
		return entry.used;
	}

	/**
	 * Passive replies still available for `messageId`: 0 once the window closed or filled up.
	 *
	 * The reply layer reserves slots here so a progress notice cannot eat the answer's budget.
	 */
	remaining(messageId: string, now: number): number {
		const entry = this.entries.get(messageId);
		if (!entry || now - entry.receivedAt >= this.windowMs) return 0;
		return Math.max(0, this.limit - entry.used);
	}

	/** Drop expired windows once the map grows, so a long-running daemon does not leak. */
	private prune(now: number): void {
		if (this.entries.size <= 1024) return;
		for (const [id, entry] of this.entries) {
			if (now - entry.receivedAt >= this.windowMs) this.entries.delete(id);
		}
	}
}

/** Daily proactive counters, keyed by the local date they belong to. */
export interface ProactiveCounts {
	/** Local `YYYY-MM-DD` of the counters. */
	day: string;
	/** Proactive sends per openid on that day. */
	sentToday: Record<string, number>;
}

/** Where the daily proactive counters live; the adapter backs it with `state.json`. */
export interface ProactiveStorage {
	load(): ProactiveCounts;
	save(counts: ProactiveCounts): void;
}

export interface ProactiveBudgetOptions {
	perMinute: number;
	perDay: number;
	storage?: ProactiveStorage;
}

/** Local calendar day of `now`, as `YYYY-MM-DD`. */
export function localDateKey(now: number): string {
	const date = new Date(now);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Token bucket for proactive sends: one per-user sliding minute window plus a persisted daily cap.
 *
 * Proactive messages are the ones QQ did not invite, so they are the ones the platform throttles;
 * the daily counter survives restarts through `storage` and resets when the local date changes.
 */
export class ProactiveBudget {
	private readonly perMinute: number;
	private readonly perDay: number;
	private readonly storage: ProactiveStorage | undefined;
	private readonly recent = new Map<string, number[]>();
	private counts: ProactiveCounts;

	constructor(options: ProactiveBudgetOptions) {
		this.perMinute = options.perMinute;
		this.perDay = options.perDay;
		this.storage = options.storage;
		this.counts = options.storage?.load() ?? { day: "", sentToday: {} };
	}

	/** Claim one proactive send for `openid`, or return false when a cap is reached. */
	takeProactive(openid: string, now: number): boolean {
		this.rollDay(now);
		const timestamps = this.recentSince(openid, now);
		if (timestamps.length >= this.perMinute) return false;
		const used = this.counts.sentToday[openid] ?? 0;
		if (used >= this.perDay) return false;

		timestamps.push(now);
		this.recent.set(openid, timestamps);
		this.counts.sentToday[openid] = used + 1;
		this.storage?.save(this.counts);
		return true;
	}

	/** Sends still allowed for `openid`: the tighter of the minute and day caps. */
	remaining(openid: string, now: number): number {
		this.rollDay(now);
		const minute = this.perMinute - this.recentSince(openid, now).length;
		const day = this.perDay - (this.counts.sentToday[openid] ?? 0);
		return Math.max(0, Math.min(minute, day));
	}

	/** Counters as the settings panel shows them. */
	snapshot(openid: string, now: number): { minute: number; minuteLimit: number; day: number; dayLimit: number } {
		this.rollDay(now);
		return {
			minute: this.recentSince(openid, now).length,
			minuteLimit: this.perMinute,
			day: this.counts.sentToday[openid] ?? 0,
			dayLimit: this.perDay,
		};
	}

	/** Timestamps of the sends inside the trailing minute, with older ones dropped. */
	private recentSince(openid: string, now: number): number[] {
		const cutoff = now - MINUTE_MS;
		const kept = (this.recent.get(openid) ?? []).filter((timestamp) => timestamp > cutoff);
		this.recent.set(openid, kept);
		return kept;
	}

	/** Reset the daily counters when the local date changed since they were written. */
	private rollDay(now: number): void {
		const day = localDateKey(now);
		if (this.counts.day === day) return;
		this.counts = { day, sentToday: {} };
		this.storage?.save(this.counts);
	}
}
