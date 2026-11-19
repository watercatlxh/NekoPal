import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChannelName } from "../channel/types.ts";
import { nextRun, parseSchedule } from "../cron/schedule.ts";
import type { JobStore } from "../cron/store.ts";

const parameters = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("list"),
		Type.Literal("remove"),
		Type.Literal("pause"),
		Type.Literal("resume"),
	]),
	name: Type.Optional(Type.String({ description: "Job name, shown with every delivery" })),
	schedule: Type.Optional(
		Type.String({ description: '30m, 2h, 1d, "in 30m", a 5-field cron expression, or an ISO timestamp' }),
	),
	prompt: Type.Optional(Type.String({ description: "Instruction the scheduled run follows" })),
	timezone: Type.Optional(Type.String({ description: "IANA timezone for cron schedules, such as Asia/Shanghai" })),
	model: Type.Optional(Type.String({ description: 'Model override, as "provider/id"' })),
	id: Type.Optional(Type.String({ description: "Job id or name, for list/remove/pause/resume" })),
});

export interface CronToolOptions {
	store: JobStore;
	deliver: { channel: ChannelName; chatId: string };
}

function formatNext(at: number | undefined): string {
	return at === undefined ? "-" : new Date(at).toLocaleString();
}

/** The `cron` tool: schedule recurring runs delivered to this chat. */
export function cronTool(options: CronToolOptions): ToolDefinition<typeof parameters> {
	return defineTool({
		name: "cron",
		label: "cron",
		description:
			'Schedule a prompt to run later and deliver its reply to this chat. Schedules: 30m, 2h, 1d (repeat), "in 30m", a 5-field cron expression, or an ISO timestamp.',
		promptSnippet: "cron: schedule recurring runs whose reply is delivered to this chat",
		parameters,
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			const text = (value: string): AgentToolResult<unknown> => ({
				content: [{ type: "text", text: value }],
				details: undefined,
			});

			if (params.action === "list") {
				const jobs = options.store.load();
				if (jobs.length === 0) return text("No scheduled jobs.");
				return text(
					jobs
						.map(
							(job) =>
								`${job.id} · ${job.name} · ${job.schedule} · next ${formatNext(job.nextRunAt)} · ${job.enabled ? (job.lastStatus ?? "pending") : "paused"}`,
						)
						.join("\n"),
				);
			}

			if (params.action === "add") {
				if (!params.name || !params.schedule || !params.prompt) {
					throw new Error("add requires name, schedule and prompt");
				}
				const now = new Date();
				const schedule = parseSchedule(params.schedule, now, params.timezone);
				const runAt = nextRun(schedule, now, params.timezone);
				if (runAt === undefined) throw new Error("The schedule has no next run.");
				const job = options.store.add({
					name: params.name,
					schedule: params.schedule,
					timezone: params.timezone,
					prompt: params.prompt,
					model: params.model,
					deliver: options.deliver,
					enabled: true,
					nextRunAt: runAt,
				});
				return text(`Scheduled ${job.name} (${job.id}) for ${formatNext(runAt)}.`);
			}

			const ref = params.id;
			if (!ref) throw new Error(`${params.action} requires id`);
			const job = options.store.find(ref);
			if (!job) throw new Error(`No job matches ${ref}`);
			if (params.action === "remove") {
				options.store.remove(job.id);
				return text(`Removed ${job.id}.`);
			}
			options.store.update(job.id, (entry) => {
				entry.enabled = params.action === "resume";
			});
			return text(`${params.action === "pause" ? "Paused" : "Resumed"} ${job.id}.`);
		},
	});
}
