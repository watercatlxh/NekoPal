import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, type ModelRuntime, type SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ChannelAction, ChannelName, Inbound, Lang } from "../channel/types.ts";
import type { CommandContext, CommandTable } from "../commands/index.ts";
import { parseCommand } from "../commands/index.ts";
import { loginCommand, logoutCommand } from "../commands/login.ts";
import { createCommands } from "../commands/table.ts";
import type { JobStore } from "../cron/store.ts";
import { t } from "../i18n/index.ts";
import { log } from "../log.ts";
import type { MemoryStore, PendingStore } from "../memory/store.ts";
import { discoverModels } from "../panel/discover.ts";
import { actButton, decode, type PanelButton, type PanelPage, toKeyboard } from "../panel/encode.ts";
import { providerTaken, upsertProvider } from "../panel/models-json.ts";
import { commandFor, LOGIN_PROVIDER_IDS, pageFor, view as viewOf } from "../panel/router.ts";
import type { ProviderDraft } from "../panel/wizard.ts";
import * as wizard from "../panel/wizard.ts";
import type { StateStore } from "../state.ts";
import type { ChatContext } from "./context.ts";
import type { ChatRegistry } from "./registry.ts";

/** A message whose sender is not on the channel allowlist. */
const IGNORE_LOG_INTERVAL_MS = 60 * 60_000;

export interface DispatcherOptions {
	registry: ChatRegistry;
	state: StateStore;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	memory: MemoryStore;
	pending: PendingStore;
	jobs: JobStore;
	agentDir: string;
	/** The agent's working directory; attachments are saved under its `inbox`. */
	workspace: string;
	skills: { apply(operations: import("../memory/store.ts").MemoryOperation[]): void };
	startedAt: number;
	version: string;
	enabledChannels: string[];
	/** Allowlist per channel: Telegram user ids, QQ openids. */
	allowed(channel: ChannelName, userId: string): boolean;
	/** The QQ proactive-quota line for a user, when QQ is running. */
	qqQuota?(chatId: string, lang: Lang): string | undefined;
}

/**
 * Routes inbound messages: allowlist, pending questions, commands, then the agent.
 *
 * Every chat's work is serialized through its own promise chain, so a message that arrives while a
 * reply runs is queued rather than interleaved.
 */
export class Dispatcher {
	private readonly options: DispatcherOptions;
	private readonly commands: CommandTable;
	private readonly ignoredAt = new Map<string, number>();
	/** Custom-provider wizard state, keyed by chat id; one flow per chat. */
	private readonly wizards = new Map<string, ProviderDraft>();

	constructor(options: DispatcherOptions) {
		this.options = options;
		this.commands = createCommands();
	}

	get commandTable(): CommandTable {
		return this.commands;
	}

	handle(message: Inbound): void {
		if (!this.options.allowed(message.channel, message.userId)) {
			const key = `${message.channel}-${message.userId}`;
			const last = this.ignoredAt.get(key) ?? 0;
			if (Date.now() - last > IGNORE_LOG_INTERVAL_MS) {
				this.ignoredAt.set(key, Date.now());
				log("info", `ignored ${message.channel} message from ${message.userId} (not in allowlist)`);
			}
			return;
		}
		void this.dispatch(message);
	}

	/**
	 * Route a button press: run the command it stands for, then rewrite the panel message in place.
	 *
	 * The press carries the chat and message, so the panel is one message per chat that each press
	 * rewrites, rather than a new message per tap.
	 */
	handleAction(action: ChannelAction): void {
		if (!this.options.allowed(action.channel, action.userId)) {
			log("info", `ignored ${action.channel} button press from ${action.userId} (not in allowlist)`);
			return;
		}
		void this.dispatchAction(action);
	}

	private async dispatchAction(action: ChannelAction): Promise<void> {
		// A wizard step, the custom-provider flow's own buttons, or a package install, first.
		if (await this.handleWizard(action)) return;
		if (await this.handlePackageAdd(action)) return;
		// The model pages carry their target in the arg: `mdl:pvd:<id>` opens a provider, `mdl:pg:<id>:<n>` pages it.
		const press = decode(action.data);
		if (press?.page === "mdl" && (press.verb === "pvd" || press.verb === "pg")) {
			const [provider, page] = press.arg.split(":");
			await this.renderPanel(action, "mdl", `${provider} ${page ?? ""}`.trim());
			return;
		}
		const command = commandFor(action.data);
		if (command === undefined) {
			// A navigation press only re-renders the page it names.
			const page = pageFor(action.data);
			if (page === undefined) return;
			await this.renderPanel(action, page);
			return;
		}
		const parsed = parseCommand(command);
		if (!parsed) return;
		const message: Inbound = {
			channel: action.channel,
			chatId: action.chatId,
			userId: action.userId,
			messageId: action.messageId,
			text: command,
			attachments: [],
		};
		const chat = await this.options.registry.chatFor(message);
		chat.replyTo = action.messageId;
		const entry = this.commands.get(parsed.name);
		if (!entry) return;
		try {
			await entry.run(this.commandContext(chat, message), parsed.args);
		} catch (error) {
			log("error", `/${parsed.name} from a button failed: ${String(error)}`);
		}
		// Show the page the button came from, so the panel reflects what the command just changed.
		const page = pageFor(action.data);
		if (page !== undefined) await this.renderPanel(action, page);
	}

	/**
	 * The package install button: it asks for a source and installs it as the typed message arrives.
	 * Returns false for any press it does not own, so the generic mapping still sees it.
	 */
	private async handlePackageAdd(action: ChannelAction): Promise<boolean> {
		const press = decode(action.data);
		if (!press || press.page !== "pkg" || press.verb !== "add") return false;
		const message = this.inboundFor(action);
		const chat = await this.options.registry.chatFor(message);
		chat.replyTo = action.messageId;
		// The pending prompt takes the next typed message, so the source arrives as an answer.
		const source = await chat.ask(t(chat.lang, "pkg.askSource"));
		if (source === undefined || source.trim() === "") {
			await chat.say("wizard.cancelled");
			return true;
		}
		const context = this.commandContext(chat, message);
		const manager = new DefaultPackageManager({
			cwd: chat.workspace,
			agentDir: context.agentDir,
			settingsManager: context.settingsManager,
		});
		try {
			await manager.installAndPersist(source.trim());
		} catch (error) {
			await chat.sendPlain(`安装失败：${error instanceof Error ? error.message : String(error)}`);
			return true;
		}
		for (const other of context.registry.all()) await other.session.reload();
		await chat.say("pkg.installed", { source: source.trim() });
		await this.renderPanel(action, "pkg");
		return true;
	}

	/**
	 * The custom-provider flow: its first button opens the wizard, later steps arrive as messages,
	 * and its API-kind, login and confirm buttons land here.
	 *
	 * Only the wizard's own verbs are handled; `nav:pvd` and `pvd:rm` fall through to the generic
	 * mapping so the provider page keeps working without a draft in flight.
	 */
	private async handleWizard(action: ChannelAction): Promise<boolean> {
		const press = decode(action.data);
		if (!press || press.page !== "pvd") return false;
		const wizardVerbs = new Set(["add", "cancel", "api", "save", "login", "logout", "oauth", "out"]);
		if (!wizardVerbs.has(press.verb)) return false;
		const chat = await this.options.registry.chatFor(this.inboundFor(action));
		chat.replyTo = action.messageId;
		const context = this.commandContext(chat, this.inboundFor(action));

		if (press.verb === "add") {
			const draft = wizard.newDraft();
			this.wizards.set(chat.chatId, draft);
			await chat.sendPlain(`${wizard.question(draft, chat.lang)}\n\n（/cancel 取消）`);
			return true;
		}
		if (press.verb === "cancel") {
			this.wizards.delete(chat.chatId);
			await chat.say("wizard.cancelled");
			await this.renderPanel(action, "pvd");
			return true;
		}
		if (press.verb === "login") {
			// No provider yet: one button per OAuth provider.
			await this.showWizardPage(action, chat, "🔐 登录哪个提供商？", [
				LOGIN_PROVIDER_IDS.map((provider) => actButton(provider, `pvd:oauth:${provider}`)),
			]);
			return true;
		}
		if (press.verb === "logout") {
			const configured = context.modelRuntime
				.getProviders()
				.filter((provider) => context.modelRuntime.getProviderAuthStatus(provider.id).configured)
				.map((provider) => provider.id);
			if (configured.length === 0) {
				await chat.sendPlain("没有已登录的提供商");
				return true;
			}
			await this.showWizardPage(action, chat, "🚪 登出哪个提供商？", [
				configured.slice(0, 6).map((id) => actButton(id, `pvd:out:${id}`)),
			]);
			return true;
		}
		// The OAuth and logout flows need a link tap, so they report in their own messages; they
		// carry their target in the arg and never need a draft in flight.
		if (press.verb === "oauth") {
			await loginCommand(context, press.arg);
			return true;
		}
		if (press.verb === "out") {
			await logoutCommand(context, press.arg);
			await this.renderPanel(action, "pvd");
			return true;
		}
		const draft = this.wizards.get(chat.chatId);
		if (draft === undefined) {
			await chat.sendPlain("没有进行中的自定义 API 流程");
			return true;
		}
		if (press.verb === "api") {
			const next = wizard.applyChoice(draft, "api", press.arg);
			if (next === undefined) return true;
			this.wizards.set(chat.chatId, next);
			await chat.sendPlain(`${wizard.question(next, chat.lang)}\n\n（/cancel 取消）`);
			return true;
		}
		if (press.verb === "save") {
			await this.saveProvider(action, chat, context, draft);
			return true;
		}
		return false;
	}

	/** Probe the provider's model list, show the confirm page, and leave the draft pending. */
	private async probeAndConfirm(action: ChannelAction, chat: ChatContext, draft: ProviderDraft): Promise<void> {
		const discovery = await discoverModels(draft.baseUrl, draft.apiKey);
		const next = wizard.withProbe(draft, discovery.models, discovery.error);
		this.wizards.set(chat.chatId, next);
		const lines = [`provider: ${next.id}`, `baseUrl: ${next.baseUrl}`, `api: ${next.api}`, `apiKey: ${next.apiKey}`];
		if (discovery.error === undefined) lines.push(t(chat.lang, "wizard.found", { n: discovery.models.length }));
		else {
			lines.push(t(chat.lang, "wizard.probeFailed", { error: discovery.error }));
			lines.push(t(chat.lang, "wizard.probeFailedHint"));
		}
		if (discovery.models.length > 0) lines.push(discovery.models.slice(0, 20).join(", "));
		await this.showWizardPage(action, chat, lines.join("\n"), [
			[actButton(t(chat.lang, "wizard.save"), "pvd:save"), actButton(t(chat.lang, "wizard.cancel"), "pvd:cancel")],
		]);
	}

	/** Write the draft to `models.json` and make the new models usable immediately. */
	private async saveProvider(
		action: ChannelAction,
		chat: ChatContext,
		context: CommandContext,
		draft: ProviderDraft,
	): Promise<void> {
		try {
			upsertProvider(context.agentDir, wizard.toProvider(draft));
			await context.modelRuntime.refresh();
		} catch (error) {
			await chat.sendPlain(`写入失败：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		this.wizards.delete(chat.chatId);
		await chat.say("wizard.saved", { id: draft.id, n: draft.models.length });
		await this.renderPanel(action, "pvd");
	}

	/** Rewrite the panel message with `text` and `rows`, falling back to a new message. */
	private async showWizardPage(
		action: ChannelAction,
		chat: ChatContext,
		text: string,
		rows: ReadonlyArray<ReadonlyArray<PanelButton>>,
	): Promise<void> {
		const keyboard = toKeyboard(rows);
		const edited = await chat.editRich({ id: action.messageId }, text, keyboard).catch((error: unknown) => {
			log("warn", `could not rewrite the wizard page: ${String(error)}`);
			return false;
		});
		if (!edited) await chat.sendRich(text, undefined, keyboard);
	}

	/** Advance the custom-provider wizard with a typed answer. */
	private async answerWizard(chat: ChatContext, message: Inbound): Promise<void> {
		const draft = this.wizards.get(chat.chatId);
		if (draft === undefined) return;
		chat.replyTo = message.messageId;
		const context = this.commandContext(chat, message);
		const taken = (id: string): boolean =>
			providerTaken(
				context.agentDir,
				id,
				context.modelRuntime.getProviders().map((provider) => provider.id),
			);
		const answer = wizard.applyText(draft, message.text, taken);
		if ("error" in answer) {
			await chat.sendPlain(this.wizardError(chat, answer.error, draft, message.text.trim()));
			return;
		}
		const next = answer.draft;
		if (next.step === "confirm") {
			// The key is in hand: probe the model list, then ask for the write.
			await this.probeAndConfirm(this.actionFor(chat, message), chat, next);
			return;
		}
		this.wizards.set(chat.chatId, next);
		await chat.sendPlain(`${wizard.question(next, chat.lang)}\n\n（/cancel 取消）`);
	}

	/** The line to show when an answer was rejected. */
	private wizardError(chat: ChatContext, error: string, draft: ProviderDraft, text: string): string {
		const lang = chat.lang;
		if (error === "taken") return t(lang, "wizard.taken", { id: text });
		if (error === "id") return t(lang, "wizard.badId");
		if (error === "baseUrl") return t(lang, "wizard.badUrl");
		return wizard.question(draft, chat.lang);
	}

	/** A synthetic action for a step that arrived as a typed message. */
	private actionFor(chat: ChatContext, message: Inbound): ChannelAction {
		return {
			channel: message.channel,
			chatId: chat.chatId,
			userId: message.userId,
			messageId: message.messageId,
			data: "pvd:save",
		};
	}

	/** The inbound message a button press stands for, so a chat can be opened for it. */
	private inboundFor(action: ChannelAction): Inbound {
		return {
			channel: action.channel,
			chatId: action.chatId,
			userId: action.userId,
			messageId: action.messageId,
			text: "/settings",
			attachments: [],
		};
	}

	/** Rewrite the message a press came from with a fresh page. */
	private async renderPanel(action: ChannelAction, page: PanelPage, arg = ""): Promise<void> {
		const message: Inbound = {
			channel: action.channel,
			chatId: action.chatId,
			userId: action.userId,
			messageId: action.messageId,
			text: "/settings",
			attachments: [],
		};
		const chat = await this.options.registry.chatFor(message);
		const view = viewOf(this.commandContext(chat, message), page, arg);
		const edited = await chat
			.editRich({ id: action.messageId }, view.text, toKeyboard(view.rows))
			.catch((error: unknown) => {
				log("warn", `could not rewrite the panel: ${String(error)}`);
				return false;
			});
		if (!edited) await chat.sendRich(view.text, undefined, toKeyboard(view.rows));
	}

	private async dispatch(message: Inbound): Promise<void> {
		const chat = await this.options.registry.chatFor(message);
		const parsed = parseCommand(message.text);

		// A pending question takes the next message, except /cancel, which aborts it.
		if (chat.pendingPrompt && parsed?.name !== "cancel") {
			if (chat.answerPending(message.text)) return;
		}

		// A wizard step takes the next message: the answer is typed, not a command.
		if (this.wizards.has(chat.chatId) && parsed === undefined) {
			await this.answerWizard(chat, message);
			return;
		}

		if (parsed && this.commands.has(parsed.name)) {
			// Commands run outside the chat's queue so /stop can interrupt a running turn.
			const command = this.commands.get(parsed.name)!;
			void command
				.run(this.commandContext(chat, message), parsed.args)
				.catch((error: unknown) => log("error", `/${parsed.name} failed: ${String(error)}`));
			return;
		}

		await chat.enqueue(async () => {
			// Replies to this turn reference the inbound message, so QQ can use passive slots.
			chat.replyTo = message.messageId;
			const images = message.attachments
				.filter((attachment) => attachment.kind === "image")
				.map((attachment) => ({
					type: "image" as const,
					data: attachment.data.toString("base64"),
					mimeType: attachment.mimeType,
				}));
			const text = this.withAttachments(message);
			chat.noteUserTurn();
			try {
				await chat.session.prompt(text, {
					images: images.length > 0 ? images : undefined,
					streamingBehavior: chat.session.isStreaming ? "followUp" : undefined,
				});
				if (chat.session.isStreaming && chat.session.pendingMessageCount > 0) {
					await chat.say("queue.acked", { n: chat.session.pendingMessageCount });
				}
			} catch (error) {
				log("warn", `prompt failed: ${String(error)}`);
				await chat.say("error.busy");
			}
		});
	}

	/** Save non-image attachments to the workspace inbox and append their paths and transcripts. */
	private withAttachments(message: Inbound): string {
		const parts = [message.text];
		for (const attachment of message.attachments) {
			if (attachment.kind === "image") continue;
			const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
			const dir = join(this.options.workspace, "inbox");
			mkdirSync(dir, { recursive: true });
			const path = join(dir, `${stamp}-${attachment.fileName}`);
			writeFileSync(path, attachment.data);
			parts.push(`[attachment saved: ${path}]`);
		}
		for (const attachment of message.attachments) {
			if (attachment.transcript) parts.push(`[voice transcript: ${attachment.transcript}]`);
		}
		return parts.join("\n");
	}

	private commandContext(chat: ChatContext, message: Inbound): CommandContext {
		return {
			chat,
			message,
			registry: this.options.registry,
			memory: this.options.memory,
			pending: this.options.pending,
			jobs: this.options.jobs,
			settingsManager: this.options.settingsManager,
			modelRuntime: this.options.modelRuntime,
			agentDir: this.options.agentDir,
			skills: this.options.skills,
			setLang: (lang: Lang) => {
				this.options.registry.setLang(`${message.channel}-${message.chatId}`, lang);
			},
			startedAt: this.options.startedAt,
			version: this.options.version,
			enabledChannels: this.options.enabledChannels,
			qqQuota: this.options.qqQuota
				? () => {
						const line = this.options.qqQuota?.(message.chatId, chat.lang);
						return line === undefined || line === "" ? undefined : line;
					}
				: undefined,
		};
	}
}

export { t };
