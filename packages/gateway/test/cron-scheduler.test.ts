import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextRun, parseSchedule } from "../src/cron/schedule.ts";
import { JobStore } from "../src/cron/store.ts";

const NOW = new Date("2026-11-19T09:00:00Z");

function store(): JobStore {
	return new JobStore(join(mkdtempSync(join(tmpdir(), "nekopal-sched-")), "jobs.json"));
}

describe("due jobs", () => {
	it("advances nextRunAt before a run so a crash cannot repeat it", () => {
		const jobs = store();
		const schedule = parseSchedule("30m", NOW);
		const job = jobs.add({
			name: "water",
			schedule: "30m",
			prompt: "drink",
			deliver: { channel: "telegram", chatId: "1" },
			enabled: true,
			nextRunAt: NOW.getTime(),
		});

		// What the scheduler does for a due job: advance first, then run.
		const advanced = jobs.update(job.id, (entry) => {
			entry.nextRunAt = nextRun(schedule, NOW) ?? NOW.getTime();
		});
		expect(advanced?.nextRunAt).toBe(NOW.getTime() + 30 * 60_000);

		// A second tick at the same instant finds nothing due.
		expect(jobs.load().filter((entry) => entry.enabled && entry.nextRunAt <= NOW.getTime())).toEqual([]);
	});

	it("disables a one-off after it advances", () => {
		const jobs = store();
		const schedule = parseSchedule("in 5m", NOW);
		const job = jobs.add({
			name: "once",
			schedule: "in 5m",
			prompt: "ping",
			deliver: { channel: "telegram", chatId: "1" },
			enabled: true,
			nextRunAt: NOW.getTime() + 5 * 60_000,
		});

		jobs.update(job.id, (entry) => {
			const next = nextRun(schedule, new Date(NOW.getTime() + 5 * 60_000));
			if (next === undefined) entry.enabled = false;
			else entry.nextRunAt = next;
		});
		expect(jobs.find(job.id)?.enabled).toBe(false);
	});
});
