import type { Lang } from "../channel/types.ts";
import { t } from "../i18n/index.ts";
import type { MemoryStore, PendingMemory } from "../memory/store.ts";

/** Character counts of both stores. */
export function formatUsage(store: MemoryStore): { memory: number; user: number } {
	return store.usage();
}

/** Numbered stored entries, so `/memory forget <n>` can address them. */
export function formatStored(store: MemoryStore): string {
	const lines: string[] = [];
	let index = 1;
	for (const target of ["memory", "user"] as const) {
		for (const entry of store.entries(target)) {
			const text = entry.replace(/\s+/g, " ");
			lines.push(`${index++}. [${target}] ${text.length > 80 ? `${text.slice(0, 77)}…` : text}`);
		}
	}
	return lines.length === 0 ? "" : lines.join("\n");
}

/** Numbered suggestions waiting for approval. */
export function formatPending(entries: PendingMemory[]): string {
	if (entries.length === 0) return "";
	return entries
		.map((entry, index) => `${index + 1}. [${entry.target}] ${entry.summary} (${entry.id})`)
		.join("\n");
}

/** The `/memory list` body: stored entries first, then pending suggestions. */
export function memoryListText(store: MemoryStore, pending: PendingMemory[], lang: Lang): string {
	const stored = formatStored(store);
	const waiting = formatPending(pending);
	const blocks = [stored || t(lang, "memory.empty")];
	if (waiting) blocks.push(`${t(lang, "memory.pending", { entries: "" }).replace(/\n$/, "")}\n${waiting}`);
	return blocks.join("\n\n");
}
