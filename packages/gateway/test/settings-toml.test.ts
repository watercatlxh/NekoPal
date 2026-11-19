import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

function workspace(): { cwd: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "nekopal-settings-"));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { cwd, agentDir };
}

describe("settings.toml", () => {
	it("writes TOML and keeps the previous file as .bak", async () => {
		const { cwd, agentDir } = workspace();
		const manager = SettingsManager.create(cwd, agentDir);
		manager.setDefaultModel("x");
		await manager.flush();
		expect(readFileSync(join(agentDir, "settings.toml"), "utf-8")).toContain('defaultModel = "x"');

		manager.setDefaultModel("y");
		await manager.flush();
		expect(readFileSync(join(agentDir, "settings.toml"), "utf-8")).toContain('defaultModel = "y"');
		expect(readFileSync(join(agentDir, "settings.toml.bak"), "utf-8")).toContain('defaultModel = "x"');
	});

	it("merges [nekopal.memory] over the defaults", async () => {
		const { cwd, agentDir } = workspace();
		const manager = SettingsManager.create(cwd, agentDir);
		writeFileSync(join(agentDir, "settings.toml"), "[nekopal.memory]\nmemoryChars = 3000\n", "utf-8");
		await manager.reload();
		const settings = manager.getNekoPal();
		expect(settings.memory?.memoryChars).toBe(3000);
		expect(settings.memory?.userChars).toBe(1375);
	});
});
