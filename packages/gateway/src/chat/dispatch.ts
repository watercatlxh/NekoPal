import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ChannelAction, ChannelName, Inbound, Lang, SentHandle } from "../channel/types.ts";
import type { CommandContext, CommandTable } from "../commands/index.ts";
import { parseCommand } from "../commands/index.ts";
import { loginCommand, logoutCommand } from "../commands/login.ts";
import { storedEntries } from "../commands/memory.ts";
import {
	createCommands,
	packageManager,
	presentPanel,
	refreshAfterWrite,
	removePackage,
	showPanel,
	showResume,
} from "../commands/table.ts";
import type { JobStore } from "../cron/store.ts";
import { t } from "../i18n/index.ts";
import { log } from "../log.ts";
import type { MemoryStore, PendingStore } from "../memory/store.ts";
import { discoverModels } from "../panel/discover.ts";
import { actButton, decode, type PanelButton, type PanelPress, pendingKey, resolvePanelKey } from "../panel/encode.ts";
import { API_KINDS, listCustomProviders, providerTaken, upsertProvider } from "../panel/models-json.ts";
import { commandFor, LOGIN_PROVIDER_IDS } from "../panel/router.ts";
import type { ProviderDraft } from "../panel/wizard.ts";
import * as wizard from "../panel/wizard.ts";
import type { StateStore } from "../state.ts";
import type { ChatContext, PendingPrompt } from "./context.ts";
import type { ChatRegistry } from "./registry.ts";

type PanelAction = ChannelAction & { origin?: CommandContext["panelOrigin"] };

interface FlowScope {
	readonly id: string;
	handle?: SentHandle;
	committed?: boolean;
	/** Navigation after commit changes the page, but cannot stop or restart the operation. */
	detached?: boolean;
}

interface WizardFlow extends FlowScope {
	kind: "wizard";
	draft: ProviderDraft;
	probe?: AbortController;
}

type PickerFlow = FlowScope & { kind: "loginPicker" | "logoutPicker"; choices: readonly string[] };
type PackageFlow = FlowScope & { kind: "package"; pending?: PendingPrompt };
type MenuFlow = WizardFlow | PickerFlow | PackageFlow | (FlowScope & { kind: "login" });

function cancelButton(chat: ChatContext, id: string): PanelButton {
	return actButton(t(chat.lang, "wizard.cancel"), `set:cancel:${id}`);
}

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
	private readonly flows = new WeakMap<ChatContext, MenuFlow>();

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
		const kind = parseCommand(message.text)?.name;
		void this.dispatch(message).catch(() =>
			this.reportFailure(message, kind && this.commands.has(kind) ? kind : "message"),
		);
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
		const origin = { handle: action.channel === "telegram" ? { id: action.messageId } : undefined };
		void this.dispatchAction({ ...action, origin }).catch(() => this.reportFailure(this.inboundFor(action), "panel"));
	}

	private async reportFailure(message: Inbound, kind: string): Promise<void> {
		log("error", `dispatch: ${kind} failed`);
		try {
			const chat = await this.options.registry.chatFor(message);
			await chat.adapter.sendMarkdown(chat.chatId, t(chat.lang, "error.busy"), message.messageId);
		} catch {
			// No usable delivery channel remains.
		}
	}

	private async dispatchAction(action: PanelAction): Promise<void> {
		const press = decode(action.data);
		if (!press) return;
		const message = this.inboundFor(action);
		const chat = await this.options.registry.chatFor(message);
		chat.replyTo = action.channel === "qq" || !action.origin?.handle ? action.messageId : undefined;
		const context = { ...this.commandContext(chat, message), panelOrigin: action.origin ?? {} };
		if (press.page === "set" && press.verb === "close" && !press.arg) {
			await presentPanel(chat, t(chat.lang, "panel.closed"), [], context.panelOrigin.handle, message.messageId);
			return;
		}
		if (press.verb === "nav") {
			this.leaveFlow(chat);
			return showPanel(context, press.page);
		}
		if (await this.handleFlow(context, press)) return;
		const { page, verb, arg } = press;
		if (page === "ses" && verb === "list" && arg === "") {
			this.leaveFlow(chat);
			return showResume(context, 0);
		}
		if (verb === "pg" && /^pg:/.test(action.data)) {
			if (page === "ses") {
				this.leaveFlow(chat);
				return showResume(context, Number(arg));
			}
			if (page === "mdl" || page === "pvd" || page === "pkg" || page === "mem" || page === "job") {
				this.leaveFlow(chat);
				return showPanel(context, page, arg);
			}
			return;
		}
		if (await this.handleSelection(context, press)) return;
		const command = commandFor(press);
		const parsed = command && parseCommand(command);
		if (!parsed) return;
		this.leaveFlow(chat);
		await this.commands.get(parsed.name)?.run(context, parsed.args);
		await showPanel(context, page);
	}

	private async handleSelection(context: CommandContext, { page, verb, arg }: PanelPress): Promise<boolean> {
		const { chat } = context;
		const stale = async (history = false): Promise<true> => {
			await chat.say("panel.stale");
			if (history) await showResume(context, 0);
			else await showPanel(context, page);
			return true;
		};
		if (page === "mdl" && ["pvd", "pg", "set"].includes(verb)) {
			const runtime = chat.session.modelRuntime;
			const models = runtime.getAvailableSnapshot();
			if (verb === "set") {
				const target = resolvePanelKey(arg, models, (model) => [model.provider, model.id]);
				if (!target) return stale();
				this.leaveFlow(chat);
				await chat.session.setModel(target, { persist: true });
				await chat.say("model.set", { model: `${target.provider}/${target.id}` });
				await showPanel(context, page, "", target.provider);
				return true;
			}
			const [key, n, extra] = arg.split(":");
			if (extra !== undefined || (verb === "pvd" && n !== undefined) || (verb === "pg" && n === undefined))
				return stale();
			const provider = resolvePanelKey(key, new Set(models.map((model) => model.provider)), (id) => [id]);
			if (provider === undefined) return stale();
			this.leaveFlow(chat);
			await showPanel(context, page, n ?? "", provider);
			return true;
		}
		if (page === "ses" && verb === "resume") {
			const target = resolvePanelKey(arg, await chat.listSessions(), (session) => [session.id]);
			if (!target) return stale(true);
			this.leaveFlow(chat);
			await chat.switchSession(target.path);
			await chat.say("session.resumed", { id: target.id.slice(0, 8) });
		} else if (page === "pkg" && verb === "rm") {
			const target = resolvePanelKey(arg, packageManager(context).listConfiguredPackages(), (entry) => [
				entry.source,
			]);
			if (!target) return stale();
			this.leaveFlow(chat);
			await removePackage(context, target.source);
		} else if (page === "mem" && verb === "fg") {
			const target = resolvePanelKey(arg, storedEntries(context.memory), (entry) => [entry.target, entry.text]);
			if (!target) return stale();
			this.leaveFlow(chat);
			const removed = context.memory.forget(target.target, target.index);
			await chat.say("memory.forgot", { entry: removed.slice(0, 60) });
		} else if (page === "mem" && (verb === "ok" || verb === "no")) {
			const entries = context.pending.list();
			if (!entries.length || pendingKey(entries.map((entry) => entry.id)) !== arg) return stale();
			this.leaveFlow(chat);
			await this.commands.get("memory")?.run(context, `${verb === "ok" ? "approve" : "reject"} all`);
		} else if (page === "job" && ["rm", "pause", "resume"].includes(verb)) {
			const target = resolvePanelKey(arg, context.jobs.load(), (entry) => [entry.id]);
			if (!target) return stale();
			this.leaveFlow(chat);
			await this.commands.get("jobs")?.run(context, `${verb} ${target.id}`);
		} else if (page === "pvd" && verb === "rm") {
			let custom: string[];
			try {
				custom = listCustomProviders(context.agentDir);
			} catch {
				await chat.say("wizard.readFailed");
				return true;
			}
			const target = resolvePanelKey(arg, custom, (id) => [id]);
			if (!target) return stale();
			this.leaveFlow(chat);
			await this.commands.get("settings")?.run(context, `pvd rm ${target}`);
		} else {
			return false;
		}
		await showPanel(context, page);
		return true;
	}

	/** Release only the owner; a continuation from an old login or install must not touch its successor. */
	private release(chat: ChatContext, flow: MenuFlow): boolean {
		if (this.flows.get(chat) !== flow) return false;
		this.flows.delete(chat);
		if (chat.menuPrompt?.id === flow.id) chat.menuPrompt = undefined;
		return true;
	}

	private leaveFlow(chat: ChatContext): void {
		const flow = this.flows.get(chat);
		if (!flow) return;
		if (flow.committed) {
			flow.detached = true;
			return;
		}
		this.release(chat, flow);
		if (flow.kind === "wizard") flow.probe?.abort();
		if (flow.kind === "login" || (flow.kind === "package" && flow.pending && chat.pendingPrompt === flow.pending)) {
			chat.cancelPending();
		}
	}

	private showParent(context: CommandContext, flow: MenuFlow): Promise<void> {
		return showPanel({ ...context, panelOrigin: { handle: flow.handle } }, flow.kind === "package" ? "pkg" : "pvd");
	}

	private async finishFlow(context: CommandContext, flow: MenuFlow): Promise<void> {
		if (this.release(context.chat, flow) && !flow.detached) await this.showParent(context, flow);
	}

	private async cancelFlow(context: CommandContext, flow: MenuFlow): Promise<void> {
		const { chat } = context;
		this.leaveFlow(chat);
		// A picker has no outstanding request: cancel and Back both just return to Providers.
		if (flow.kind === "package" || flow.kind === "wizard" || flow.kind === "login") {
			await chat.say(flow.kind === "login" ? "login.cancelled" : "wizard.cancelled");
		}
		if (!this.flows.has(chat)) await this.showParent(context, flow);
	}

	private enablePrompt(chat: ChatContext, flow: MenuFlow): void {
		chat.menuPrompt = { id: flow.id, keyboard: [[cancelButton(chat, flow.id)]] };
	}

	private async addPackage(context: CommandContext, flow: PackageFlow): Promise<void> {
		const { chat } = context;
		this.enablePrompt(chat, flow);
		const question = chat.ask(t(chat.lang, "pkg.askSource"));
		flow.pending = chat.pendingPrompt;
		const source = (await question)?.trim();
		flow.pending = undefined;
		if (this.flows.get(chat) !== flow) return;
		// QQ parent delivery must reference the source answer, not the earlier install click.
		const answer = {
			...context,
			message: { ...context.message, messageId: chat.replyTo ?? context.message.messageId },
		};
		if (!source) return this.cancelFlow(answer, flow);
		// installAndPersist cannot be rolled back. Retire the keyboard *before* handing it the source.
		flow.committed = true;
		chat.menuPrompt = undefined;
		try {
			await packageManager(context).installAndPersist(source);
		} catch (error) {
			await chat.sendPlain(`安装失败：${error instanceof Error ? error.message : String(error)}`);
			await this.finishFlow(answer, flow);
			return;
		}
		for (const other of context.registry.all()) await other.session.reload();
		await chat.say("pkg.installed", { source });
		await this.finishFlow(answer, flow);
	}

	private async startFlow(context: CommandContext, kind: "wizard" | "package" | PickerFlow["kind"]): Promise<void> {
		const { chat } = context;
		if (this.flows.has(chat) || chat.pendingPrompt) return chat.say("panel.flowBusy");
		const scope = { id: randomUUID(), handle: context.panelOrigin?.handle };
		const flow: MenuFlow =
			kind === "wizard"
				? { ...scope, kind, draft: wizard.newDraft() }
				: kind === "package"
					? { ...scope, kind }
					: { ...scope, kind, choices: [] };
		this.flows.set(chat, flow);
		try {
			if (flow.kind === "wizard") await this.showWizardPage(chat, flow);
			else if (flow.kind === "package") await this.addPackage(context, flow);
			else await this.showPicker(context, flow);
		} catch (error) {
			this.release(chat, flow);
			throw error;
		}
	}

	private async handleFlow(context: CommandContext, { page, verb, arg }: PanelPress): Promise<boolean> {
		const { chat } = context;
		if (
			!arg &&
			((page === "pkg" && verb === "add") || (page === "pvd" && ["add", "login", "logout"].includes(verb)))
		) {
			await this.startFlow(
				context,
				page === "pkg" ? "package" : verb === "add" ? "wizard" : verb === "login" ? "loginPicker" : "logoutPicker",
			);
			return true;
		}
		const flow = this.flows.get(chat);
		if (page === "set" && verb === "cancel") {
			if (flow && !flow.committed && flow.id === arg) await this.cancelFlow(context, flow);
			else await chat.say("panel.stale");
			return true;
		}
		if (page === "pvd" && ["oauth", "out", "back"].includes(verb)) {
			await this.selectAuth(context, verb, arg, flow);
			return true;
		}
		if (page !== "pvd" || (verb !== "api" && verb !== "save")) return false;
		const [index, choiceId, extra] = arg.split(":");
		if (
			flow?.kind !== "wizard" ||
			flow.committed ||
			(verb === "api" ? choiceId : arg) !== flow.id ||
			extra !== undefined
		) {
			await chat.say("panel.stale");
		} else if (verb === "api") {
			const kind = /^\d$/.test(index) ? API_KINDS[Number(index)] : undefined;
			const next = kind && wizard.applyChoice(flow.draft, "api", kind);
			if (!next) await chat.say("panel.stale");
			else {
				flow.draft = next;
				await this.showWizardPage(chat, flow);
			}
		} else if (flow.probe || flow.draft.step !== "confirm") {
			await chat.say("panel.stale");
		} else {
			await this.saveProvider(context, flow);
		}
		return true;
	}

	private async logoutChoices(context: CommandContext): Promise<readonly string[]> {
		const credentials = await context.modelRuntime.listCredentials();
		return LOGIN_PROVIDER_IDS.filter((id) =>
			credentials.some((cred) => cred.providerId === id && cred.type === "oauth"),
		);
	}

	private async showPicker(context: CommandContext, flow: PickerFlow): Promise<void> {
		const { chat } = context;
		const login = flow.kind === "loginPicker";
		const ids = login ? LOGIN_PROVIDER_IDS : await this.logoutChoices(context);
		if (this.flows.get(chat) !== flow) return;
		flow.choices = ids;
		const rows: PanelButton[][] = [];
		for (let i = 0; i < ids.length; i += 2) {
			rows.push(ids.slice(i, i + 2).map((id) => actButton(id, `pvd:${login ? "oauth" : "out"}:${id}:${flow.id}`)));
		}
		rows.push([actButton(t(chat.lang, "panel.back"), `pvd:back:${flow.id}`), cancelButton(chat, flow.id)]);
		const title = login ? "wizard.loginChoose" : ids.length ? "wizard.logoutChoose" : "wizard.logoutEmpty";
		flow.handle = await presentPanel(chat, t(chat.lang, title), rows, flow.handle, context.message.messageId);
	}

	private async selectAuth(context: CommandContext, verb: string, arg: string, flow?: MenuFlow): Promise<void> {
		const { chat } = context;
		if (!flow || flow.committed || (flow.kind !== "loginPicker" && flow.kind !== "logoutPicker"))
			return chat.say("panel.stale");
		if (verb === "back" && arg === flow.id) return this.cancelFlow(context, flow);
		const [provider, id, extra] = arg.split(":");
		if (
			verb !== (flow.kind === "loginPicker" ? "oauth" : "out") ||
			id !== flow.id ||
			extra !== undefined ||
			!flow.choices.includes(provider)
		) {
			return chat.say("panel.stale");
		}
		if (verb === "oauth") {
			// The picker and the in-flight login have distinct button lifetimes.
			const login: MenuFlow = { kind: "login", id: randomUUID(), handle: flow.handle };
			this.flows.set(chat, login);
			this.enablePrompt(chat, login);
			try {
				await loginCommand(context, provider);
			} finally {
				const message = { ...context.message, messageId: chat.replyTo ?? context.message.messageId };
				await this.finishFlow({ ...context, message }, login);
			}
		} else {
			const ids = await this.logoutChoices(context);
			if (this.flows.get(chat) !== flow || flow.committed) return;
			if (!ids.includes(provider)) {
				this.release(chat, flow);
				await chat.say("panel.stale");
				if (!this.flows.has(chat)) await this.showParent(context, flow);
				return;
			}
			flow.committed = true;
			try {
				await logoutCommand(context, provider);
			} finally {
				await this.finishFlow(context, flow);
			}
		}
	}

	private async saveProvider(context: CommandContext, flow: WizardFlow): Promise<void> {
		const { chat } = context;
		const draft = flow.draft;
		try {
			upsertProvider(
				context.agentDir,
				wizard.toProvider(draft),
				context.modelRuntime.getProviders().map((p) => p.id),
			);
		} catch {
			await chat.say("wizard.writeFailed");
			return;
		}
		// Consume synchronously. A repeated button may arrive while the catalog refresh is still pending.
		flow.committed = true;
		try {
			await refreshAfterWrite(context, "wizard.saved", { id: draft.id, n: draft.models.length });
		} finally {
			await this.finishFlow(context, flow);
		}
	}

	private async showWizardPage(
		chat: ChatContext,
		flow: WizardFlow,
		notice?: string,
		replyTo = chat.replyTo,
	): Promise<void> {
		const { text, rows } = wizard.page(flow.draft, chat.lang, flow.id, notice);
		flow.handle = await presentPanel(chat, text, rows, flow.handle, replyTo);
	}

	private async answerWizard(chat: ChatContext, message: Inbound, flow: WizardFlow): Promise<void> {
		chat.replyTo = message.messageId;
		if (flow.probe) return;
		const { draft } = flow;
		let answer: wizard.Answer;
		try {
			answer = wizard.applyText(draft, message.text, (id) =>
				providerTaken(
					this.options.agentDir,
					id,
					this.options.modelRuntime.getProviders().map((provider) => provider.id),
				),
			);
		} catch {
			await chat.say("wizard.readFailed");
			return;
		}
		if ("error" in answer) {
			await this.showWizardPage(chat, flow, this.wizardError(chat, answer.error, draft, message.text.trim()));
			return;
		}
		flow.draft = answer.draft;
		if (answer.draft.step === "confirm") {
			flow.probe = new AbortController();
			const discovery = await discoverModels(answer.draft.baseUrl, answer.draft.apiKey, flow.probe.signal);
			if (this.flows.get(chat) !== flow) return;
			flow.draft = wizard.withProbe(answer.draft, discovery.models, discovery.error);
			flow.probe = undefined;
		}
		await this.showWizardPage(chat, flow, undefined, message.messageId);
	}

	/** The line to show when an answer was rejected. */
	private wizardError(chat: ChatContext, error: string, draft: ProviderDraft, text: string): string {
		const lang = chat.lang;
		if (error === "taken") return t(lang, "wizard.taken", { id: text });
		if (error === "id") return t(lang, "wizard.badId");
		if (error === "baseUrl") return t(lang, "wizard.badUrl");
		return wizard.question(draft, chat.lang);
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

	private async dispatch(message: Inbound): Promise<void> {
		const parsed = parseCommand(message.text);
		if (parsed?.name === "settings" && /^act(?:\s|$)/.test(parsed.args)) {
			return this.dispatchAction({ ...message, data: parsed.args.slice(3).trim() });
		}
		const chat = await this.options.registry.chatFor(message);
		const flow = this.flows.get(chat);
		if (parsed?.name === "cancel" && flow) {
			chat.replyTo = message.messageId;
			if (!flow.committed) await this.cancelFlow(this.commandContext(chat, message), flow);
			else await chat.say("panel.stale");
			return;
		}

		// A pending question takes the next message, except /cancel, which aborts it.
		if (chat.pendingPrompt && parsed?.name !== "cancel") {
			chat.replyTo = message.messageId;
			if (chat.answerPending(message.text)) return;
		}

		// A wizard step takes the next message: the answer is typed, not a command.
		if (flow?.kind === "wizard" && !flow.committed && parsed === undefined) {
			await this.answerWizard(chat, message, flow);
			return;
		}

		if (parsed && this.commands.has(parsed.name)) {
			if (flow && ["settings", "sessions", "resume", "packages", "model"].includes(parsed.name))
				this.leaveFlow(chat);
			// Commands run outside the chat's queue so /stop can interrupt a running turn.
			const command = this.commands.get(parsed.name)!;
			chat.replyTo = message.messageId;
			await command.run(this.commandContext(chat, message), parsed.args);
			return;
		}

		await chat.enqueue(async () => {
			// Replies to this turn reference the inbound message, so QQ can use passive slots.
			chat.replyTo = message.messageId;
			// SDK sessions can fall back to another available model. A retired saved model must be
			// reselected explicitly, not silently billed against a different model or provider.
			const provider = this.options.settingsManager.getDefaultProvider();
			const model = this.options.settingsManager.getDefaultModel();
			if (provider && model && !this.options.modelRuntime.getModel(provider, model)) {
				await chat.say("model.reselect");
				return;
			}
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
