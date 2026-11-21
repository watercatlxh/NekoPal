import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach } from "vitest";
import type { Adapter, Caps, Inbound, Keyboard, SentHandle } from "../../src/channel/types.ts";
import { Dispatcher } from "../../src/chat/dispatch.ts";
import { ChatRegistry } from "../../src/chat/registry.ts";
import { JobStore } from "../../src/cron/store.ts";
import { SkillStore } from "../../src/memory/skills.ts";
import { MemoryStore, PendingStore } from "../../src/memory/store.ts";
import { StateStore } from "../../src/state.ts";

const caps: Caps = { edit: true, stream: false, rich: true, maxChars: 4_000 };

/** Records what the dispatcher sends; `next(needle)` resolves with the first message containing it. */
export class FakeAdapter implements Adapter {
	readonly name = "telegram" as const;
	readonly caps = caps;
	readonly sent: string[] = [];
	readonly edits: string[] = [];
	readonly editedIds: string[] = [];
	readonly deleted: string[] = [];
	/** The buttons each send or edit carried, so a test can assert the panel's layout. */
	readonly keyboards: Array<Keyboard | undefined> = [];
	private nextId = 1;
	private readonly waiters: Array<{ needle: string; resolve(text: string): void }> = [];

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	/** The first sent or edited message that contains `needle`, waiting for it if necessary. */
	next(needle = ""): Promise<string> {
		const found = [...this.sent, ...this.edits].find((text) => text.includes(needle));
		if (found !== undefined) return Promise.resolve(found);
		return new Promise((resolve) => {
			this.waiters.push({ needle, resolve });
		});
	}

	/** Resolve every waiter whose needle `text` now satisfies. */
	private resolveWaiters(text: string): void {
		for (const waiter of [...this.waiters]) {
			if (!text.includes(waiter.needle)) continue;
			this.waiters.splice(this.waiters.indexOf(waiter), 1);
			waiter.resolve(text);
		}
	}

	async sendMarkdown(_chatId: string, markdown: string): Promise<SentHandle[]> {
		this.sent.push(markdown);
		this.resolveWaiters(markdown);
		return [{ id: String(this.nextId++) }];
	}

	async sendRich(_chatId: string, markdown: string, _replyTo?: string, keyboard?: Keyboard): Promise<SentHandle> {
		const handle = { id: String(this.nextId++) };
		this.sent.push(markdown);
		this.keyboards.push(keyboard);
		this.resolveWaiters(markdown);
		return handle;
	}

	async editText(): Promise<void> {}
	async editRich(_chatId: string, handle: SentHandle, markdown: string, keyboard?: Keyboard): Promise<boolean> {
		this.edits.push(markdown);
		this.editedIds.push(handle.id);
		this.keyboards.push(keyboard);
		this.resolveWaiters(markdown);
		return true;
	}
	async editMarkup(): Promise<void> {}
	async deleteMessage(_chatId: string, handle: SentHandle): Promise<void> {
		this.deleted.push(handle.id);
	}
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

export interface Harness {
	adapter: FakeAdapter;
	faux: ReturnType<typeof registerFauxProvider>;
	deliver(text: string, userId?: string): Promise<void>;
	press(data: string): Promise<void>;
	settle(): Promise<void>;
}

/** Yield until the dispatcher's promise chain has drained. */
export async function settle(): Promise<void> {
	for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve));
}

export async function createHarness(options: { allowed?: string[] } = {}): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "nekopal-dispatch-"));
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

	const state = StateStore.load(join(root, "state.json"));
	const settingsManager = SettingsManager.inMemory({
		defaultProvider: model.provider,
		defaultModel: model.id,
		defaultTools: [],
	});
	const memory = new MemoryStore({
		memoryPath: join(root, "MEMORY.md"),
		userPath: join(root, "USER.md"),
		budgets: { memoryChars: 2_200, userChars: 1_375 },
	});
	const pending = new PendingStore(join(root, "pending"));
	const jobs = new JobStore(join(root, "jobs.json"));
	const skills = new SkillStore(join(root, "skills"));

	const adapter = new FakeAdapter();
	const registry = new ChatRegistry({
		state,
		workspace,
		agentDir,
		settingsManager,
		modelRuntime,
		memory,
		pending,
		jobs,
		redactor: { secrets: () => [] },
		defaultLang: "en",
	});
	registry.registerAdapter(adapter);

	const dispatcher = new Dispatcher({
		registry,
		state,
		settingsManager,
		modelRuntime,
		memory,
		pending,
		jobs,
		agentDir,
		workspace,
		skills,
		startedAt: Date.now(),
		version: "0.1.0",
		enabledChannels: ["telegram"],
		allowed: (_channel, userId) => (options.allowed ?? ["42"]).includes(userId),
	});

	disposers.push(async () => {
		await registry.dispose();
		faux.unregister();
	});

	return {
		adapter,
		faux,
		async press(data: string): Promise<void> {
			dispatcher.handleAction({
				channel: "telegram",
				chatId: "42",
				userId: "42",
				messageId: String(Date.now()),
				data,
			});
			await settle();
		},
		async deliver(text: string, userId = "42"): Promise<void> {
			const message: Inbound = {
				channel: "telegram",
				chatId: "42",
				userId,
				messageId: String(Date.now()),
				text,
				attachments: [],
			};
			dispatcher.handle(message);
			await settle();
		},
		settle,
	};
}

/** A scripted assistant message for the faux provider. */
export function fauxText(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}
