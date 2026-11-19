import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { graceMs, nextRun, parseSchedule } from "../src/cron/schedule.ts";
import { JobStore } from "../src/cron/store.ts";

const NOW = new Date("2026-11-19T00:00:00Z");

describe("parseSchedule", () => {
	it("parses an interval", () => {
		expect(parseSchedule("30m", NOW)).toEqual({ kind: "interval", intervalMs: 30 * 60_000 });
		expect(parseSchedule("2h", NOW)).toEqual({ kind: "interval", intervalMs: 2 * 3_600_000 });
		expect(parseSchedule("1d", NOW)).toEqual({ kind: "interval", intervalMs: 86_400_000 });
	});

	it("rejects an interval under a minute", () => {
		expect(() => parseSchedule("0m", NOW)).toThrow(/at least 1 minute/);
	});

	it("parses a one-off", () => {
		expect(parseSchedule("in 2h", NOW)).toEqual({ kind: "once", runAt: NOW.getTime() + 2 * 3_600_000 });
	});

	it("parses a five-field cron expression and honours the timezone", () => {
		const schedule = parseSchedule("0 9 * * *", NOW, "Asia/Shanghai");
		expect(schedule).toEqual({ kind: "cron", expr: "0 9 * * *" });
		// 09:00 in Shanghai is 01:00 UTC.
		const next = nextRun(schedule, NOW, "Asia/Shanghai");
		expect(new Date(next!).toISOString()).toBe("2026-11-19T01:00:00.000Z");
	});

	it("parses an ISO timestamp later than now", () => {
		const schedule = parseSchedule("2026-12-01T09:00:00Z", NOW);
		expect(schedule).toEqual({ kind: "once", runAt: Date.parse("2026-12-01T09:00:00Z") });
		expect(() => parseSchedule("2026-01-01T00:00:00Z", NOW)).toThrow(/must be in the future/);
	});

	it("rejects an unrecognized schedule with the documented message", () => {
		expect(() => parseSchedule("tomorrow", NOW)).toThrow(
			'Unrecognized schedule. Use 30m / 2h / 1d, "in 30m", a 5-field cron expression, or an ISO timestamp.',
		);
	});
});

describe("graceMs", () => {
	it("is half the interval, clamped between 2 minutes and 2 hours", () => {
		expect(graceMs({ kind: "interval", intervalMs: 30 * 60_000 })).toBe(15 * 60_000);
		expect(graceMs({ kind: "interval", intervalMs: 86_400_000 })).toBe(2 * 3_600_000);
		expect(graceMs({ kind: "interval", intervalMs: 60_000 })).toBe(120_000);
	});

	it("is half the gap between two cron runs, clamped", () => {
		expect(graceMs({ kind: "cron", expr: "* * * * *" }, NOW)).toBe(120_000);
		expect(graceMs({ kind: "cron", expr: "0 9 * * *" }, NOW, "UTC")).toBe(2 * 3_600_000);
	});

	it("is two minutes for a one-off", () => {
		expect(graceMs({ kind: "once", runAt: NOW.getTime() })).toBe(120_000);
	});
});

describe("JobStore", () => {
	let store: JobStore;

	beforeEach(() => {
		const dir = mkdtempSync(join(tmpdir(), "nekopal-jobs-"));
		store = new JobStore(join(dir, "jobs.json"));
	});

	it("adds, finds by prefix and name, updates and removes", () => {
		const job = store.add({
			name: "water",
			schedule: "30m",
			prompt: "drink water",
			deliver: { channel: "telegram", chatId: "42" },
			enabled: true,
			nextRunAt: NOW.getTime() + 1_800_000,
		});
		expect(store.find(job.id.slice(0, 4))?.id).toBe(job.id);
		expect(store.find("water")?.id).toBe(job.id);

		store.update(job.id, (entry) => {
			entry.enabled = false;
		});
		expect(store.find(job.id)?.enabled).toBe(false);

		expect(store.remove(job.id)).toBe(true);
		expect(store.load()).toEqual([]);
	});
});
