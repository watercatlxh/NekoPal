import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AgentToolResult, SettingsManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool, SettingsSchema } from "@earendil-works/pi-coding-agent";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { SETTINGS_BACKUP_PATH, SETTINGS_PATH } from "../paths.ts";

const parameters = Type.Object({
	key: Type.String({ description: 'Dot path such as "nekopal.memory.reviewEveryTurns" or "defaultModel"' }),
	value: Type.String({ description: 'TOML value literal, such as 5, "text", or [1, 2]' }),
});

const validateSettings = Compile(SettingsSchema);

const SECRET_KEY = /^nekopal\.channels\.[a-z]+\.(botToken|appSecret)$/;

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
	let cursor = target;
	for (const part of path.slice(0, -1)) {
		const next = cursor[part];
		if (typeof next !== "object" || next === null) cursor[part] = {};
		cursor = cursor[part] as Record<string, unknown>;
	}
	cursor[path[path.length - 1]] = value;
}

export interface ConfigSetToolOptions {
	settingsManager: SettingsManager;
	path?: string;
}

/** The `config_set` tool: validated, atomic edits of settings.toml. */
export function configSetTool(options: ConfigSetToolOptions): ToolDefinition<typeof parameters> {
	const settingsPath = options.path ?? SETTINGS_PATH;
	return defineTool({
		name: "config_set",
		label: "config_set",
		description:
			"Change one settings.toml value. The value is a TOML literal. Secrets must reference an environment variable ($NAME) or a command (!cmd).",
		promptSnippet: "config_set: change a settings.toml value (validated; secrets must use $ENV or !command)",
		parameters,
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			const path = params.key.split(".").filter(Boolean);
			if (path.length === 0) throw new Error("key must be a dot path");

			let value: unknown;
			try {
				value = (parseToml(`v = ${params.value}`) as { v: unknown }).v;
			} catch {
				throw new Error("value is not a TOML literal");
			}

			if (SECRET_KEY.test(params.key)) {
				if (typeof value !== "string" || !/^[$!]/.test(value)) {
					throw new Error("secrets must reference an environment variable ($NAME) or command (!cmd)");
				}
			}

			const current = existsSync(settingsPath)
				? (parseToml(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>)
				: {};
			const next = structuredClone(current);
			setPath(next, path, value);

			const errors = [...validateSettings.Errors(next)];
			if (errors.length > 0) {
				const first = errors[0];
				throw new Error(`Invalid settings: ${first.instancePath || "/"} ${first.message}`);
			}

			if (existsSync(settingsPath)) copyFileSync(settingsPath, SETTINGS_BACKUP_PATH);
			const temp = `${settingsPath}.tmp-${process.pid}`;
			writeFileSync(temp, stringifyToml(next), "utf-8");
			renameSync(temp, settingsPath);
			await options.settingsManager.reload();

			const note = params.key.startsWith("nekopal.channels.") ? " Takes effect after the daemon restarts." : "";
			return {
				content: [{ type: "text", text: `Set ${params.key} = ${params.value}.${note}` }],
				details: undefined,
			};
		},
	});
}
