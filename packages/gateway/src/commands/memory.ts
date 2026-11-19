import type { Lang } from "../channel/types.ts";
import { t } from "../i18n/index.ts";
import type { MemoryStore, PendingMemory } from "../memory/store.ts";

/** One stored entry, numbered the way `/memory list` prints it. */
export interface StoredEntry {
	/** 1-based number across both stores. */
	number: number;
	target: "memory" | "user";
	/** 1-based position inside its own store, which is what `MemoryStore.forget` takes. */
	index: number;
	text: string;
}

/** Every stored entry, memory first, numbered as `/memory list` shows them. */
export function storedEntries(store: MemoryStore): StoredEntry[] {
	const entries: StoredEntry[] = [];
	for (const target of ["memory", "user"] as const) {
		for (const [index, text] of store.entries(target).entries()) {
			entries.push({ number: entries.length + 1, target, index: index + 1, text });
		}
	}
	return entries;
}

/** Character counts of both stores. */
export function formatUsage(store: MemoryStore): { memory: number; user: number } {
	return store.usage();
}

/** Numbered stored entries, so `/memory forget <n>` can address them. */
export function formatStored(store: MemoryStore): string {
	const lines = storedEntries(store).map((entry) => {
		const text = entry.text.replace(/\s+/g, " ");
		const shown = text.length > 80 ? `${text.slice(0, 77)}…` : text;
		return `${entry.number}. [${entry.target}] ${shown}`;
	});
	return lines.length === 0 ? "" : lines.join("\n");
}

/** Numbered suggestions waiting for approval. */
export function formatPending(entries: PendingMemory[]): string {
	if (entries.length === 0) return "";
	return entries.map((entry, index) => `${index + 1}. [${entry.target}] ${entry.summary} (${entry.id})`).join("\n");
}

/** The `/memory list` body: stored entries first, then pending suggestions. */
export function memoryListText(store: MemoryStore, pending: PendingMemory[], lang: Lang): string {
	const stored = formatStored(store);
	const waiting = formatPending(pending);
	const blocks = [stored || t(lang, "memory.empty")];
	if (waiting) blocks.push(`${t(lang, "memory.pending", { entries: "" }).replace(/\n$/, "")}\n${waiting}`);
	return blocks.join("\n\n");
}
