import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { checkProtectedPath, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, Caps, SentHandle } from "../src/channel/types.ts";
import { Daemon } from "../src/daemon.ts";
import { StateStore } from "../src/state.ts";
import { createHarness } from "./support/harness.ts";

const caps: Caps = { edit: true, stream: false, rich: true, maxChars: 4_000 };

class FakeAdapter implements Adapter {
	readonly name = "telegram" as const;
	readonly caps = caps;
	readonly sent: string[] = [];
	started = false;
	stopped = false;

	async start(): Promise<void> {
		this.started = true;
	}
	async stop(): Promise<void> {
		this.stopped = true;
	}
	async sendMarkdown(_chatId: string, markdown: string): Promise<SentHandle[]> {
		this.sent.push(markdown);
		return [{ id: "1" }];
	}
	async sendRich(_chatId: string, markdown: string): Promise<SentHandle> {
		this.sent.push(markdown);
		return { id: "1" };
	}
	async editText(): Promise<void> {}
	async editRich(): Promise<boolean> {
		return true;
	}
	async editMarkup(): Promise<void> {}
	async deleteMessage(): Promise<void> {}
	async sendFiles(): Promise<void> {}
	openStream(): undefined {
		return undefined;
	}
	async notifyWorking(): Promise<void> {}
}

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (disposers.length > 0) await disposers.pop()!();
});

describe("Daemon", () => {
	it("starts and stops its adapters and protects the settings files", async () => {
		const root = mkdtempSync(join(tmpdir(), "nekopal-daemon-"));
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(workspace, { recursive: true });
		const authPath = join(agentDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ faux: { type: "api_key", key: "faux-key" } }), "utf-8");

		const faux = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 100_000, maxTokens: 1_000 }] });
		const model = faux.getModel();
		const modelRuntime = await ModelRuntime.create({ authPath, modelsPath: null });
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((entry) => ({
				id: entry.id,
				name: entry.name,
				api: entry.api,
				reasoning: entry.reasoning,
				input: entry.input,
				cost: entry.cost,
				contextWindow: entry.contextWindow,
				maxTokens: entry.maxTokens,
				baseUrl: entry.baseUrl,
			})),
		});
		const settingsManager = SettingsManager.inMemory({ defaultTools: [] });
		const adapter = new FakeAdapter();
		const daemon = new Daemon({
			settingsManager,
			modelRuntime,
			adapters: [adapter],
			version: "0.1.0",
			workspace,
			agentDir,
			state: StateStore.load(join(root, "state.json")),
		});
		disposers.push(async () => {
			await daemon.stop();
			faux.unregister();
		});

		await daemon.start();
		expect(adapter.started).toBe(true);
		// The settings files are writable by the daemon, not by the write/edit tools.
		expect(checkProtectedPath(join(agentDir, "settings.toml"))).toContain("config_set");
		expect(checkProtectedPath(join(agentDir, "auth.json"))).toContain("/login");

		await daemon.stop();
		expect(adapter.stopped).toBe(true);
	});

	it("answers /settings with the live panel", async () => {
		const harness = await createHarness();
		await harness.deliver("/settings");
		const panel = await harness.adapter.next("NekoPal");
		expect(panel).toContain("Language: en");
		expect(panel).toContain("Memory:");
		// The panel carries buttons: one per area, and the language pair.
		const keyboard = harness.adapter.keyboards.find((entry) => entry !== undefined);
		expect(keyboard?.flat().map((button) => button.data)).toContain("nav:mdl");
	});

	it("exposes the command list a platform menu needs", async () => {
		const { commandMenu } = await import("../src/commands/table.ts");
		const menu = commandMenu("en");
		expect(menu.map((entry) => entry.command)).toContain("settings");
		expect(menu.every((entry) => entry.description.length > 0)).toBe(true);
		expect(menu.map((entry) => entry.command)).not.toContain("cancel");
	});
});
