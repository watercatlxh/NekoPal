import type { Lang } from "../channel/types.ts";
import { t } from "../i18n/index.ts";
import type { Job } from "../cron/store.ts";

/** `/jobs` list lines: id, name, schedule, next run and last status. */
export function formatJobs(jobs: Job[], lang: Lang): string {
	void lang;
	return jobs
		.map((job) => {
			const next = new Date(job.nextRunAt).toLocaleString();
			const status = job.enabled ? (job.lastStatus ?? "pending") : "paused";
			return `${job.id} · ${job.name} · ${job.schedule} · ${next} · ${status}`;
		})
		.join("\n");
}

export { t };
