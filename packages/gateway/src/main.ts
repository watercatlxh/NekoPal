import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Adapter } from "./channel/types.ts";
import { commandMenu } from "./commands/table.ts";
import { Daemon } from "./daemon.ts";
import { t } from "./i18n/index.ts";
import { log, logError } from "./log.ts";
import { HOME, SETTINGS_PATH } from "./paths.ts";
import { StateStore } from "./state.ts";

const VERSION = "0.1.0";

/** Expand a leading `~` to the home directory. */
function expandHome(path: string): string {
	return path.startsWith("~/") || path === "~" ? join(homedir(), path.slice(1)) : path;
}

/**
 * Build the adapters the settings enable.
 *
 * Both adapters are loaded lazily so a deployment that only uses one never imports the other's code.
 */
async function createAdapters(
	settingsManager: SettingsManager,
	state: StateStore,
	menu: Array<{ command: string; description: string }>,
): Promise<Adapter[]> {
	const channels = settingsManager.getNekoPal().channels;
	const adapters: Adapter[] = [];
	if (channels?.telegram?.enabled) {
		const { createTelegramAdapter } = await import("./channel/telegram/adapter.ts");
		adapters.push(
			createTelegramAdapter({
				settingsManager,
				log,
				logError,
				commands: menu,
				offset: state.telegramOffset,
				onOffset: (offset) => {
					state.telegramOffset = offset;
				},
			}),
		);
	}
	if (channels?.qq?.enabled) {
		const { createQqAdapter } = await import("./channel/qq/adapter.ts");
		adapters.push(createQqAdapter({ settingsManager, log, logError }));
	}
	return adapters;
}

async function main(): Promise<number> {
	const args = process.argv.slice(2).filter((arg) => arg !== "");
	if (args.length > 0) {
		process.stderr.write(`${t("en", "daemon.args", { settings: SETTINGS_PATH })}\n`);
		return 2;
	}

	mkdirSync(HOME, { recursive: true });
	const settingsManager = SettingsManager.create(HOME, HOME);
	const settings = settingsManager.getNekoPal();
	const state = StateStore.load();
	const adapters = await createAdapters(settingsManager, state, commandMenu(settings.defaultLang ?? "en"));
	if (adapters.length === 0) {
		process.stderr.write(`${Daemon.noChannelMessage(settings.defaultLang ?? "en")}\n`);
		return 1;
	}

	const modelRuntime = await ModelRuntime.create({});
	const workspace = expandHome(settings.workspace ?? HOME);
	mkdirSync(workspace, { recursive: true });

	const daemon = new Daemon({
		settingsManager,
		modelRuntime,
		adapters,
		version: VERSION,
		workspace,
		agentDir: HOME,
		state,
	});

	let stopping = false;
	const shutdown = (signal: string): void => {
		if (stopping) return;
		stopping = true;
		log("info", `${signal} received, stopping`);
		void daemon.stop().then(
			() => process.exit(0),
			(error: unknown) => {
				logError("shutdown failed", error);
				process.exit(1);
			},
		);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));

	await daemon.start();
	return new Promise<number>(() => {
		// The adapters keep the process alive; nothing else to do here.
	});
}

main().then(
	(code) => {
		if (code !== undefined) process.exitCode = code;
	},
	(error: unknown) => {
		logError("nekopal failed to start", error);
		process.exitCode = 1;
	},
);
