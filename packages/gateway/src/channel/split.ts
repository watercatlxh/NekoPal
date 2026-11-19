export interface SplitOptions {
	/** Maximum length of one chunk, counted in UTF-16 code units (JS `string.length`). */
	maxChars: number;
	/** Chunks beyond this count mean the caller should send a document instead. */
	maxChunks: number;
}

export interface SplitResult {
	chunks: string[];
	/** True when the text needs more than `maxChunks` chunks and should be sent as a file. */
	asDocument: boolean;
}

const FENCE = "```";

/** The fence a chunk ends inside, carried to the next chunk so both sides stay valid Markdown. */
interface OpenFence {
	info: string;
}

/**
 * Split Markdown into message-sized chunks.
 *
 * Chunks break at the last newline after half of `maxChars` when one exists, so paragraphs stay
 * whole; otherwise they break hard without separating a surrogate pair. A break inside a fenced
 * code block closes the fence at the end of the chunk and reopens it, with the same info string,
 * at the start of the next one.
 */
export function splitMarkdown(text: string, options: SplitOptions): SplitResult {
	if (text.length <= options.maxChars) return { chunks: [text], asDocument: false };

	const chunks: string[] = [];
	let rest = text;
	let open: OpenFence | undefined;

	while (rest.length > 0) {
		const prefix = open ? `${FENCE}${open.info}\n` : "";
		const budget = options.maxChars - prefix.length;
		if (rest.length + prefix.length <= options.maxChars) {
			chunks.push(prefix + rest);
			break;
		}

		let cut = lastNewlineAfterHalf(rest, budget);
		if (cut <= 0) cut = safeCut(rest, budget);
		const head = rest.slice(0, cut);
		rest = rest.slice(cut);

		// Walk the chunk's own lines to learn whether it ends inside a fence.
		open = scanFences(open, head);
		const chunk = open ? `${head.replace(/\n?$/, "\n")}${FENCE}` : head;
		chunks.push(prefix + chunk);

		if (chunks.length > options.maxChunks) return { chunks: [], asDocument: true };
	}

	return { chunks, asDocument: false };
}

/** Index of the last newline after half of `budget`, or -1 when there is none. */
function lastNewlineAfterHalf(text: string, budget: number): number {
	const half = Math.floor(budget / 2);
	const index = text.lastIndexOf("\n", budget - 1);
	return index >= half ? index + 1 : -1;
}

/** Cut at `budget` without splitting a surrogate pair. */
function safeCut(text: string, budget: number): number {
	const code = text.charCodeAt(budget - 1);
	// A high surrogate at the cut would be separated from its low surrogate.
	return code >= 0xd800 && code <= 0xdbff ? budget - 1 : budget;
}

/** The fence state after `text`, starting from `open`. */
function scanFences(open: OpenFence | undefined, text: string): OpenFence | undefined {
	let current = open;
	for (const line of text.split("\n")) {
		const match = /^[ \t]*(`{3,})(.*)$/.exec(line);
		if (!match) continue;
		current = current ? undefined : { info: match[2].trim() };
	}
	return current;
}
