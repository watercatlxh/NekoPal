import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { configSetTool } from "../src/tools/config-set.ts";

function setup(): {
	tool: ReturnType<typeof configSetTool>;
	settingsPath: string;
	backupPath: string;
	manager: SettingsManager;
} {
	const root = mkdtempSync(join(tmpdir(), "nekopal-config-"));
	const settingsPath = join(root, "settings.toml");
	const backupPath = `${settingsPath}.bak`;
	writeFileSync(settingsPath, '[nekopal]\ndefaultLang = "en"\n', "utf-8");
	const manager = SettingsManager.create(root, root);
	return {
		tool: configSetTool({ settingsManager: manager, path: settingsPath, backupPath }),
		settingsPath,
		backupPath,
		manager,
	};
}

async function run(tool: ReturnType<typeof configSetTool>, key: string, value: string): Promise<string> {
	const result = await tool.execute("call", { key, value });
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("config_set", () => {
	it("writes a nested value, keeps a backup and reloads", async () => {
		const { tool, settingsPath, backupPath, manager } = setup();
		expect(await run(tool, "nekopal.memory.reviewEveryTurns", "5")).toContain("reviewEveryTurns = 5");
		expect(readFileSync(settingsPath, "utf-8")).toContain("reviewEveryTurns = 5");
		expect(readFileSync(backupPath, "utf-8")).toContain('defaultLang = "en"');
		expect(manager.getNekoPal().memory?.reviewEveryTurns).toBe(5);
	});

	it("rejects a value that is not a TOML literal", async () => {
		const { tool, settingsPath } = setup();
		const before = readFileSync(settingsPath, "utf-8");
		await expect(run(tool, "defaultModel", "not toml =")).rejects.toThrow(/not a TOML literal/);
		expect(readFileSync(settingsPath, "utf-8")).toBe(before);
	});

	it("rejects a plain secret", async () => {
		const { tool } = setup();
		await expect(run(tool, "nekopal.channels.telegram.botToken", '"123:abc"')).rejects.toThrow(
			/must reference an environment variable/,
		);
	});

	it("accepts a secret reference and notes the restart", async () => {
		const { tool, settingsPath } = setup();
		const answer = await run(tool, "nekopal.channels.telegram.botToken", '"$TG_TOKEN"');
		expect(answer).toContain("Takes effect after the daemon restarts");
		expect(readFileSync(settingsPath, "utf-8")).toContain('botToken = "$TG_TOKEN"');
	});

	it("rejects a value the schema does not allow and leaves the file alone", async () => {
		const { tool, settingsPath } = setup();
		const before = readFileSync(settingsPath, "utf-8");
		await expect(run(tool, "nekopal.memory.memoryChars", "5")).rejects.toThrow(/Invalid settings/);
		expect(readFileSync(settingsPath, "utf-8")).toBe(before);
		expect(existsSync(`${settingsPath}.bak`)).toBe(false);
	});
});
