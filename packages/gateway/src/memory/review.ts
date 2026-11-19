import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { log, logError } from "../log.ts";
import { memoryTool } from "../tools/memory.ts";
import type { MemoryStore, PendingStore } from "./store.ts";

/** Messages of the conversation a review reads. */
const REVIEW_MESSAGES = 40;
/** Character cap on the transcript handed to the review session. */
const REVIEW_CHARS = 20_000;

const REVIEW_PROMPT = `Review the conversation below and decide whether anything is worth remembering across future sessions.

Stores — pick exactly one per fact:
- target "user": who the user is — preferences, communication style, standing requests, personal details they revealed.
- target "memory": facts about the environment — machine layout, paths, services, tool quirks, config gotchas.
- target "skill": a reusable procedure that took real work to figure out. Prefer patching an existing skill over creating a new one; the same lesson learned twice is ONE rule.

Rules:
- Save only facts GROUNDED in this conversation — a user message or tool result you can point to. Never infer traits, skill level, mood or preferences from topic or tone, and never turn a one-off request into a standing preference unless the user marked it general ("always", "from now on", "remember") or stated a standing like/dislike.
- Record from failure AND success: corrections and confirmed good approaches both count.
- Do not save: things derivable from files or git history, temporary task state, one-off debugging output, failures caused by the environment (network blips, missing credentials).
- Entries are immutable: to update, patch the old entry; never append "UPDATE: …".
- If unsure, leave it out — a wrong fact misleads every future session.

If nothing is worth saving, reply exactly "Nothing to save." and stop.`;

export interface ReviewOptions {
	workspace: string;
	agentDir: string;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	memory: MemoryStore;
	pending: PendingStore;
}

/** One transcript line per message, oldest first, capped to the last `REVIEW_CHARS`. */
export function formatTranscript(messages: Array<{ role: string; text: string }>): string {
	const lines = messages
		.slice(-REVIEW_MESSAGES)
		.map((message) => `${message.role.toUpperCase()}: ${message.text.trim()}`)
		.filter((line) => line.length > 8);
	const joined = lines.join("\n\n");
	return joined.length > REVIEW_CHARS ? joined.slice(-REVIEW_CHARS) : joined;
}

/**
 * The background review: a throwaway session that proposes memories, staged for `/memory approve`.
 *
 * It never touches the chat's session and never writes memory directly: every write goes through the
 * `memory` tool with `origin: "review"`, so the user sees the suggestions first.
 */
export class MemoryReview {
	private readonly options: ReviewOptions;
	private running = false;

	constructor(options: ReviewOptions) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Review `transcript`; returns the number of newly staged suggestions. */
	async review(transcript: string): Promise<number> {
		if (this.running || transcript.trim().length === 0) return 0;
		this.running = true;
		const before = this.options.pending.list().length;
		try {
			const loader = new DefaultResourceLoader({
				cwd: this.options.workspace,
				agentDir: this.options.agentDir,
				settingsManager: this.options.settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			});
			await loader.reload();
			const { session } = await createAgentSession({
				cwd: this.options.workspace,
				agentDir: this.options.agentDir,
				settingsManager: this.options.settingsManager,
				modelRuntime: this.options.modelRuntime,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(this.options.workspace),
				tools: ["read", "memory"],
				customTools: [memoryTool({ store: this.options.memory, pending: this.options.pending, origin: "review" })],
			});
			try {
				await session.prompt(`${REVIEW_PROMPT}\n\n<conversation>\n${transcript}\n</conversation>`);
				await session.waitForIdle();
			} finally {
				await session.dispose();
			}
			return this.options.pending.list().length - before;
		} catch (error) {
			logError("memory review failed", error);
			return 0;
		} finally {
			this.running = false;
			log("info", "memory review finished");
		}
	}
}
