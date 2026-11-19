import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

function readToml(path: string): Record<string, unknown> {
	return parseToml(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/**
 * Tests for the fix to a bug where external file changes to arrays were overwritten.
 *
 * The bug scenario was:
 * 1. NekoPal starts with settings.toml containing packages: ["npm:some-pkg"]
 * 2. User externally edits file to packages: []
 * 3. User changes an unrelated setting (e.g. thinking level)
 * 4. save() would overwrite packages back to ["npm:some-pkg"] from stale in-memory state
 *
 * The fix tracks which fields were explicitly modified during the session, and only
 * those fields override file values during save().
 */
describe("SettingsManager - External Edit Preservation", () => {
	const testDir = join(process.cwd(), "test-settings-bug-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".nekopal"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("should preserve file changes to packages array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.toml");

		// Initial state: packages has one item
		writeFileSync(settingsPath, stringifyToml({ defaultModel: "claude-sonnet", packages: ["npm:pi-mcp-adapter"] }));

		// NekoPal starts up, loads settings into memory
		const manager = SettingsManager.create(projectDir, agentDir);

		// At this point, globalSettings.packages = ["npm:pi-mcp-adapter"]
		expect(manager.getPackages()).toEqual(["npm:pi-mcp-adapter"]);

		// User externally edits settings.toml to remove the package
		const currentSettings = readToml(settingsPath);
		currentSettings.packages = []; // User wants to remove this!
		writeFileSync(settingsPath, stringifyToml(currentSettings));

		// Verify file was changed
		expect(readToml(settingsPath).packages).toEqual([]);

		// User changes an UNRELATED setting (this triggers save)
		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		// With the fix, packages should be preserved as [] (not reverted to startup value)
		const savedSettings = readToml(settingsPath);

		expect(savedSettings.packages).toEqual([]);
		expect(savedSettings.defaultThinkingLevel).toBe("high");
	});

	it("should preserve file changes to extensions array when changing unrelated setting", async () => {
		const settingsPath = join(agentDir, "settings.toml");

		writeFileSync(settingsPath, stringifyToml({ defaultModel: "claude-sonnet", extensions: ["/old/extension.ts"] }));

		const manager = SettingsManager.create(projectDir, agentDir);

		// User externally updates extensions
		const currentSettings = readToml(settingsPath);
		currentSettings.extensions = ["/new/extension.ts"];
		writeFileSync(settingsPath, stringifyToml(currentSettings));

		// Change unrelated setting
		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		const savedSettings = readToml(settingsPath);

		// With the fix, extensions should be preserved (not reverted to startup value)
		expect(savedSettings.extensions).toEqual(["/new/extension.ts"]);
	});

	it("should preserve external project settings changes when updating unrelated project field", async () => {
		const projectSettingsPath = join(projectDir, ".nekopal", "settings.toml");
		writeFileSync(
			projectSettingsPath,
			stringifyToml({
				extensions: ["./old-extension.ts"],
				prompts: ["./old-prompt.md"],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = readToml(projectSettingsPath);
		currentProjectSettings.prompts = ["./new-prompt.md"];
		writeFileSync(projectSettingsPath, stringifyToml(currentProjectSettings));

		manager.setProjectExtensionPaths(["./updated-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = readToml(projectSettingsPath);
		expect(savedProjectSettings.prompts).toEqual(["./new-prompt.md"]);
		expect(savedProjectSettings.extensions).toEqual(["./updated-extension.ts"]);
	});

	it("should let in-memory project changes override external changes for the same project field", async () => {
		const projectSettingsPath = join(projectDir, ".nekopal", "settings.toml");
		writeFileSync(projectSettingsPath, stringifyToml({ extensions: ["./initial-extension.ts"] }));

		const manager = SettingsManager.create(projectDir, agentDir);

		const currentProjectSettings = readToml(projectSettingsPath);
		currentProjectSettings.extensions = ["./external-extension.ts"];
		writeFileSync(projectSettingsPath, stringifyToml(currentProjectSettings));

		manager.setProjectExtensionPaths(["./in-memory-extension.ts"]);
		await manager.flush();

		const savedProjectSettings = readToml(projectSettingsPath);
		expect(savedProjectSettings.extensions).toEqual(["./in-memory-extension.ts"]);
	});
});
