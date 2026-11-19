import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ChannelName } from "../channel/types.ts";
import { CRON_JOBS_PATH } from "../paths.ts";

export type JobStatus = "ok" | "error" | "missed";

export interface Job {
	id: string;
	name: string;
	schedule: string;
	timezone?: string;
	prompt: string;
	deliver: { channel: ChannelName; chatId: string };
	model?: string;
	enabled: boolean;
	createdAt: string;
	nextRunAt: number;
	lastRunAt?: number;
	lastStatus?: JobStatus;
	lastError?: string;
}

interface JobsFile {
	jobs: Job[];
	updatedAt: string;
}

/** The scheduled jobs, stored in one JSON file. */
export class JobStore {
	private readonly path: string;

	constructor(path: string = CRON_JOBS_PATH) {
		this.path = path;
	}

	load(): Job[] {
		if (!existsSync(this.path)) return [];
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<JobsFile>;
			return parsed.jobs ?? [];
		} catch {
			return [];
		}
	}

	save(jobs: Job[]): void {
		mkdirSync(dirname(this.path), { recursive: true });
		if (existsSync(this.path)) copyFileSync(this.path, `${this.path}.bak`);
		const temp = `${this.path}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ jobs, updatedAt: new Date().toISOString() }, null, "\t")}\n`, "utf-8");
		renameSync(temp, this.path);
	}

	/** Add a job and persist the list. */
	add(job: Omit<Job, "id" | "createdAt">): Job {
		const created: Job = { id: randomBytes(4).toString("hex"), createdAt: new Date().toISOString(), ...job };
		this.save([...this.load(), created]);
		return created;
	}

	update(id: string, change: (job: Job) => void): Job | undefined {
		const jobs = this.load();
		const job = jobs.find((entry) => entry.id === id);
		if (!job) return undefined;
		change(job);
		this.save(jobs);
		return job;
	}

	remove(id: string): boolean {
		const jobs = this.load();
		const next = jobs.filter((job) => job.id !== id);
		if (next.length === jobs.length) return false;
		this.save(next);
		return true;
	}

	/** Resolve a job by exact id, id prefix, or name. */
	find(ref: string): Job | undefined {
		const jobs = this.load();
		return (
			jobs.find((job) => job.id === ref) ??
			jobs.find((job) => job.id.startsWith(ref)) ??
			jobs.find((job) => job.name === ref)
		);
	}
}
