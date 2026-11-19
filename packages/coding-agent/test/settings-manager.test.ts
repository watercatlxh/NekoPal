import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function readToml(path: string): Record<string, unknown> {
	return parseToml(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
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

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\n');

			// Create SettingsManager (simulates pi starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.toml externally to add enabledModels
			writeFileSync(
				settingsPath,
				'defaultModel = "claude-sonnet"\nenabledModels = ["claude-opus-4-5", "gpt-5.2-codex"]\n',
			);

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = readToml(settingsPath);
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing the default model", async () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			writeFileSync(
				settingsPath,
				'defaultModel = "claude-sonnet"\nshellPath = "/bin/zsh"\nextensions = ["/path/to/extension.ts"]\n',
			);

			// User changes the default model
			manager.setDefaultModel("claude-opus-4-5");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = readToml(settingsPath);
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.defaultModel).toBe("claude-opus-4-5");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\ndefaultThinkingLevel = "low"\n');

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = readToml(settingsPath);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("deviceId", () => {
		it("creates one global device ID and reuses it in later processes", async () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\n');
			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), 'deviceId = "project-device"\n');
			const first = SettingsManager.create(projectDir, agentDir);

			const deviceId = first.getOrCreateDeviceId();
			await first.flush();

			expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			expect(first.getOrCreateDeviceId()).toBe(deviceId);
			expect(SettingsManager.create(projectDir, agentDir).getOrCreateDeviceId()).toBe(deviceId);
			expect(readToml(settingsPath)).toEqual({ defaultModel: "claude-sonnet", deviceId });
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'extensions = ["/local/ext.ts", "./relative/ext.ts"]\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(
				settingsPath,
				[
					'packages = ["npm:simple-pkg", { source = "npm:shitty-extensions", extensions = ["extensions/oracle.ts"], skills = [] }]',
					"",
				].join("\n"),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\nextensions = ["/before.ts"]\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, 'defaultModel = "claude-opus-4-5"\nextensions = ["/after.ts"]\n');

			await manager.reload();

			expect(manager.getDefaultModel()).toBe("claude-opus-4-5");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
		});

		it("should keep previous settings and report the file path when the file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid toml");
			await manager.reload();

			expect(manager.getDefaultModel()).toBe("claude-sonnet");
			expect(manager.drainErrors()).toMatchObject([{ scope: "global" }]);
		});
	});

	describe("default model setting", () => {
		it("stores provider and model and reloads them", async () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultProvider = "anthropic"\ndefaultModel = "claude-sonnet-4-5"\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDefaultProvider()).toBe("anthropic");
			expect(manager.getDefaultModel()).toBe("claude-sonnet-4-5");

			manager.setDefaultModelAndProvider("openai", "gpt-5.2");
			await manager.flush();

			const savedSettings = readToml(settingsPath);
			expect(savedSettings.defaultProvider).toBe("openai");
			expect(savedSettings.defaultModel).toBe("gpt-5.2");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.toml");
			const projectSettingsPath = join(projectDir, ".nekopal", "settings.toml");
			writeFileSync(globalSettingsPath, "{ invalid global toml");
			writeFileSync(projectSettingsPath, "{ invalid project toml");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors.map((error) => error.scope)).toEqual(["global", "project"]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("project trust", () => {
		it("should skip project settings when project is not trusted", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'defaultModel = "global"\n');
			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), 'defaultModel = "project"\n');

			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(manager.isProjectTrusted()).toBe(false);
			expect(manager.getDefaultModel()).toBe("global");
			expect(manager.getProjectSettings()).toEqual({});
		});

		it("should reload project settings after trust changes to true", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'defaultModel = "global"\n');
			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), 'defaultModel = "project"\n');
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			manager.setProjectTrusted(true);

			expect(manager.isProjectTrusted()).toBe(true);
			expect(manager.getDefaultModel()).toBe("project");
		});

		it("should fail project settings writes when project is not trusted", async () => {
			const projectSettingsPath = join(projectDir, ".nekopal", "settings.toml");
			writeFileSync(projectSettingsPath, 'packages = ["npm:existing"]\n');
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(() => manager.setProjectPackages(["npm:new"])).toThrow(
				"Project is not trusted; refusing to write project settings",
			);
			await manager.flush();

			expect(manager.getProjectSettings()).toEqual({});
			expect(readToml(projectSettingsPath)).toEqual({ packages: ["npm:existing"] });
		});

		it("should read default project trust from global settings only", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'defaultProjectTrust = "always"\n');
			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), 'defaultProjectTrust = "never"\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDefaultProjectTrust()).toBe("always");
		});

		it("should default invalid project trust settings to ask", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'defaultProjectTrust = "sometimes"\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDefaultProjectTrust()).toBe("ask");
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .nekopal folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .nekopal folder in project
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\n');

			// Delete the .nekopal folder that beforeEach created
			rmSync(join(projectDir, ".nekopal"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .nekopal folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".nekopal"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should create .nekopal folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .nekopal folder in project
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\n');

			// Delete the .nekopal folder that beforeEach created
			rmSync(join(projectDir, ".nekopal"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .nekopal folder should NOT exist yet
			expect(existsSync(join(projectDir, ".nekopal"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .nekopal folder should exist
			expect(existsSync(join(projectDir, ".nekopal"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".nekopal", "settings.toml"))).toBe(true);
		});
	});

	describe("retry settings", () => {
		it("defaults and overrides agent retry delay cap", () => {
			expect(SettingsManager.inMemory().getRetrySettings()).toEqual({
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 2000,
				maxAgentDelayMs: 60000,
			});
			expect(
				SettingsManager.inMemory({
					retry: { enabled: true, maxRetries: 10, baseDelayMs: 500, maxAgentDelayMs: 5000 },
				}).getRetrySettings(),
			).toEqual({ enabled: true, maxRetries: 10, baseDelayMs: 500, maxAgentDelayMs: 5000 });
		});
	});

	describe("httpIdleTimeoutMs", () => {
		it("should default to 5 minutes", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getHttpIdleTimeoutMs()).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		});

		it("should use merged global and project settings", () => {
			writeFileSync(join(agentDir, "settings.toml"), "httpIdleTimeoutMs = 300000\n");
			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), "httpIdleTimeoutMs = 0\n");

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getHttpIdleTimeoutMs()).toBe(0);
		});

		it("should reject invalid timeout values", () => {
			writeFileSync(join(agentDir, "settings.toml"), "httpIdleTimeoutMs = -1\n");
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(() => manager.getHttpIdleTimeoutMs()).toThrow("Invalid httpIdleTimeoutMs setting");
		});
	});

	describe("cacheWarming", () => {
		it("defaults to idle and ignores project settings", () => {
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("idle");

			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), 'cacheWarming = "streaming"\n');
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("idle");

			writeFileSync(join(agentDir, "settings.toml"), 'cacheWarming = "streaming"\n');
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("streaming");

			writeFileSync(join(agentDir, "settings.toml"), 'cacheWarming = "bogus"\n');
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("idle");
		});

		it("persists the mode globally", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setCacheWarmingMode("off");
			await manager.flush();

			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("off");
			expect(readToml(join(agentDir, "settings.toml"))).toEqual({ cacheWarming: "off" });
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'shellCommandPrefix = "shopt -s expand_aliases"\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'defaultModel = "claude-sonnet"\n');

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.toml");
			writeFileSync(settingsPath, 'shellCommandPrefix = "shopt -s expand_aliases"\n');

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			const savedSettings = readToml(settingsPath);
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("defaultTools", () => {
		it("loads global defaults and lets project settings replace them", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'defaultTools = ["read", "bash"]\n');

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["read", "bash"]);

			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), 'defaultTools = ["grep"]\n');

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["grep"]);
		});

		it("preserves an empty tool list", () => {
			expect(SettingsManager.inMemory({ defaultTools: [] }).getDefaultTools()).toEqual([]);
			expect(SettingsManager.inMemory().getDefaultTools()).toBeUndefined();
		});

		it("applies +name and -name to the default selection", () => {
			expect(SettingsManager.inMemory({ defaultTools: ["+codemode", "-write"] }).getDefaultTools()).toEqual([
				"read",
				"bash",
				"edit",
				"grep",
				"find",
				"ls",
				"memory",
				"cron",
				"send",
				"config_set",
				"codemode",
			]);
			expect(SettingsManager.inMemory({ defaultTools: ["read", "+grep", "+read"] }).getDefaultTools()).toEqual([
				"read",
				"grep",
			]);
		});

		it("layers project modifiers on top of the global selection", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'defaultTools = ["read", "bash", "+codemode"]\n');
			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), 'defaultTools = ["-codemode", "+tool_search"]\n');

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getDefaultTools()).toEqual(["read", "bash", "tool_search"]);

			manager.applyOverrides({ defaultTools: ["+codemode"] });
			expect(manager.getDefaultTools()).toEqual(["read", "bash", "tool_search", "codemode"]);
		});

		it("applies project modifiers to the built-in defaults without a global setting", () => {
			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), 'defaultTools = ["+codemode"]\n');

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual([
				"read",
				"bash",
				"edit",
				"write",
				"grep",
				"find",
				"ls",
				"memory",
				"cron",
				"send",
				"config_set",
				"codemode",
			]);
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'defaultModel = "claude-sonnet"\n');
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'sessionDir = "/tmp/sessions"\n');
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'sessionDir = "/global/sessions"\n');
			writeFileSync(join(projectDir, ".nekopal", "settings.toml"), 'sessionDir = "./sessions"\n');
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'sessionDir = "~/sessions"\n');
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});

	describe("getShellPath", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'defaultModel = "claude-sonnet"\n');
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBeUndefined();
		});

		it("should return an absolute shellPath unchanged", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'shellPath = "/bin/zsh"\n');
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe("/bin/zsh");
		});

		it("should expand ~ in shellPath", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'shellPath = "~/.local/bin/agent-shell-sandbox"\n');
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(join(homedir(), ".local/bin/agent-shell-sandbox"));
		});

		it("should expand a bare ~ in shellPath", () => {
			writeFileSync(join(agentDir, "settings.toml"), 'shellPath = "~"\n');
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(homedir());
		});
	});

	describe("NekoPal settings", () => {
		it("merges [nekopal] with defaults", () => {
			writeFileSync(join(agentDir, "settings.toml"), "[nekopal.memory]\nmemoryChars = 3000\n");

			const manager = SettingsManager.create(projectDir, agentDir);
			const nekopal = manager.getNekoPal();

			expect(nekopal.memory?.memoryChars).toBe(3000);
			expect(nekopal.memory?.userChars).toBe(1375);
		});
	});
});
