import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatJobs } from "../src/commands/jobs.ts";
import { nextRun, parseSchedule } from "../src/cron/schedule.ts";
import { JobStore } from "../src/cron/store.ts";

describe("/jobs add", () => {
	it("computes the first run from the schedule, not from now", () => {
		const now = new Date("2026-11-19T09:00:00Z");
		const schedule = parseSchedule("2h", now);
		expect(nextRun(schedule, now)).toBe(now.getTime() + 2 * 3_600_000);

		const store = new JobStore(join(mkdtempSync(join(tmpdir(), "nekopal-jobs-add-")), "jobs.json"));
		const job = store.add({
			name: "water",
			schedule: "2h",
			prompt: "drink water",
			deliver: { channel: "telegram", chatId: "42" },
			enabled: true,
			nextRunAt: nextRun(schedule, now)!,
		});
		expect(job.nextRunAt).toBe(now.getTime() + 2 * 3_600_000);
	});

	it("lists a job with its schedule, next run and status", () => {
		const store = new JobStore(join(mkdtempSync(join(tmpdir(), "nekopal-jobs-list-")), "jobs.json"));
		const now = new Date("2026-11-19T09:00:00Z");
		store.add({
			name: "water",
			schedule: "2h",
			prompt: "drink water",
			deliver: { channel: "telegram", chatId: "42" },
			enabled: true,
			nextRunAt: nextRun(parseSchedule("2h", now), now)!,
		});
		const line = formatJobs(store.load(), "en");
		expect(line).toContain("water");
		expect(line).toContain("2h");
		expect(line).toContain("pending");
	});
});
