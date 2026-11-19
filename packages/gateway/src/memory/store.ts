import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { MEMORY_FILE, PENDING_DIR, USER_FILE } from "../paths.ts";
import { firstThreat } from "./threats.ts";

export type MemoryTarget = "memory" | "user";

/** Entries are separated by this line, so an entry may contain any other text. */
const ENTRY_DELIMITER = "\n§\n";

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

const BLOCKED_ENTRY = "[BLOCKED: entry contained a suspicious pattern]";

const RULE = "═".repeat(46);

export interface MemoryOperation {
	action: "add" | "patch" | "remove";
	content?: string;
	old_text?: string;
	/** Skill directory name, for skill operations. */
	name?: string;
}

export interface MemoryBudgets {
	memoryChars: number;
	userChars: number;
}

export interface MemoryStoreOptions {
	memoryPath?: string;
	userPath?: string;
	budgets: MemoryBudgets;
}

/** 8 hex characters, short enough to type after `/memory approve`. */
export function randomId(): string {
	return randomBytes(4).toString("hex");
}

function readEntries(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split(ENTRY_DELIMITER)
		.map((entry) => entry.replace(INVISIBLE, "").trim())
		.filter((entry) => entry.length > 0);
}

function writeEntries(path: string, entries: string[]): void {
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) copyFileSync(path, `${path}.bak`);
	const temp = `${path}.tmp`;
	writeFileSync(temp, entries.length > 0 ? `${entries.join(ENTRY_DELIMITER)}\n` : "", "utf-8");
	renameSync(temp, path);
}

function renderStore(title: string, entries: string[], budget: number): string {
	const size = entries.join(ENTRY_DELIMITER).length;
	const percent = Math.round((size / budget) * 100);
	const body = entries.map((entry) => (firstThreat(entry) ? BLOCKED_ENTRY : entry)).join(ENTRY_DELIMITER);
	return `${RULE}\n${title} [${percent}%]\n${RULE}\n${body}`;
}

/** The bounded MEMORY.md / USER.md stores and their prompt rendering. */
export class MemoryStore {
	private readonly memoryPath: string;
	private readonly userPath: string;
	private readonly budgets: MemoryBudgets;

	constructor(options: MemoryStoreOptions) {
		this.memoryPath = options.memoryPath ?? MEMORY_FILE;
		this.userPath = options.userPath ?? USER_FILE;
		this.budgets = options.budgets;
	}

	private pathOf(target: MemoryTarget): string {
		return target === "memory" ? this.memoryPath : this.userPath;
	}

	private budgetOf(target: MemoryTarget): number {
		return target === "memory" ? this.budgets.memoryChars : this.budgets.userChars;
	}

	entries(target: MemoryTarget): string[] {
		return readEntries(this.pathOf(target));
	}

	/** Character counts of both stores, for /settings. */
	usage(): { memory: number; user: number } {
		return {
			memory: this.entries("memory").join(ENTRY_DELIMITER).length,
			user: this.entries("user").join(ENTRY_DELIMITER).length,
		};
	}

	/**
	 * Apply operations to one store. Every operation is validated before anything is written, so a
	 * failed batch leaves the file untouched.
	 */
	apply(target: MemoryTarget, operations: MemoryOperation[]): void {
		const entries = readEntries(this.pathOf(target));
		for (const operation of operations) applyOperation(entries, operation);
		const size = entries.join(ENTRY_DELIMITER).length;
		const budget = this.budgetOf(target);
		if (size > budget) {
			const name = target === "memory" ? "MEMORY.md" : "USER.md";
			throw new Error(`${name} would be ${size}/${budget} chars; remove or patch entries first`);
		}
		writeEntries(this.pathOf(target), entries);
	}

	/** Remove the entry at a 1-based index, as numbered by `/memory list`. */
	forget(target: MemoryTarget, index: number): string {
		const entries = readEntries(this.pathOf(target));
		if (index < 1 || index > entries.length) {
			throw new Error(`No entry #${index} in ${target === "memory" ? "MEMORY.md" : "USER.md"}`);
		}
		const [removed] = entries.splice(index - 1, 1);
		writeEntries(this.pathOf(target), entries);
		return removed;
	}

	/** Render both stores for the system prompt; empty when nothing is stored. */
	formatForPrompt(): string {
		const blocks: string[] = [];
		const memory = this.entries("memory");
		if (memory.length > 0) {
			blocks.push(renderStore("MEMORY (your personal notes)", memory, this.budgets.memoryChars));
		}
		const user = this.entries("user");
		if (user.length > 0) blocks.push(renderStore("USER PROFILE (who the user is)", user, this.budgets.userChars));
		if (blocks.length === 0) return "";
		return `${blocks.join("\n\n")}\n\nMemories are point-in-time notes; verify file paths and facts before acting on them.`;
	}
}

function applyOperation(entries: string[], operation: MemoryOperation): void {
	if (operation.action === "add") {
		const text = operation.content?.trim();
		if (!text) throw new Error("add requires content");
		if (firstThreat(text)) throw new Error("content looks like a prompt injection; refusing to store it");
		entries.push(text.replace(INVISIBLE, ""));
		return;
	}
	const needle = operation.old_text?.trim();
	if (!needle) throw new Error(`${operation.action} requires old_text`);
	const matches = entries.filter((entry) => entry.includes(needle));
	if (matches.length !== 1) throw new Error(`old_text matches ${matches.length} entries; it must match exactly one`);
	const index = entries.findIndex((entry) => entry.includes(needle));
	if (operation.action === "remove") {
		entries.splice(index, 1);
		return;
	}
	const text = operation.content?.trim();
	if (!text) throw new Error("patch requires content");
	if (firstThreat(text)) throw new Error("content looks like a prompt injection; refusing to store it");
	entries[index] = text.replace(INVISIBLE, "");
}

export interface PendingMemory {
	id: string;
	createdAt: string;
	target: "memory" | "user" | "skill";
	operations: MemoryOperation[];
	summary: string;
}

/** Suggestions staged by the background review until the user approves them. */
export class PendingStore {
	private readonly dir: string;

	constructor(dir: string = PENDING_DIR) {
		this.dir = dir;
	}

	list(): PendingMemory[] {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(readFileSync(`${this.dir}/${name}`, "utf-8")) as PendingMemory)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	add(entry: Omit<PendingMemory, "id" | "createdAt">): PendingMemory {
		mkdirSync(this.dir, { recursive: true });
		const pending: PendingMemory = { id: randomId(), createdAt: new Date().toISOString(), ...entry };
		writeFileSync(`${this.dir}/${pending.id}.json`, `${JSON.stringify(pending, null, "\t")}\n`, "utf-8");
		return pending;
	}

	remove(id: string): void {
		rmSync(`${this.dir}/${id}.json`, { force: true });
	}
}
