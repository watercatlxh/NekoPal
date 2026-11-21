/**
 * One-line summaries of tool calls, for the progress line a reply carries while it runs.
 *
 * Pure functions with no IO: the reply layer renders the lines, the tests assert them directly.
 */

/** One tool call as a single line: marker, name, and a one-line argument summary. */
export interface ToolLine {
	/** `toolCallId` of the call, so its end can update the right line. */
	readonly id: string;
	readonly name: string;
	readonly summary: string;
	status: "running" | "ok" | "error";
}

/** The argument a tool's line shows first, per built-in tool. */
const PRIMARY_ARGUMENT: Record<string, readonly string[]> = {
	bash: ["command"],
	read: ["path"],
	write: ["path"],
	edit: ["path"],
	ls: ["path"],
	grep: ["pattern"],
	find: ["pattern"],
	memory: ["target"],
	cron: ["action"],
	send: ["text", "files"],
	config_set: ["key"],
};

/** Default cap for one summary line. */
const DEFAULT_LIMIT = 60;
/** Cap for the body of a folded tool message: a chat message is a preview, not a log. */
const BODY_LIMIT = 1_500;

/** The first non-empty string among `keys` of `args`, or "" when none is usable. */
function pick(args: Record<string, unknown>, keys: readonly string[]): string {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value;
		if (Array.isArray(value) && typeof value[0] === "string" && value[0] !== "") return value[0];
	}
	return "";
}

/** The first string value in `args`, in insertion order; "" when there is none. */
function firstString(args: Record<string, unknown>): string {
	for (const value of Object.values(args)) {
		if (typeof value === "string" && value.trim() !== "") return value;
		if (Array.isArray(value) && typeof value[0] === "string" && value[0] !== "") return value[0];
	}
	return "";
}

/** A tool call's primary argument as one line, at most `limit` characters. */
export function summarizeArgs(toolName: string, args: unknown, limit = DEFAULT_LIMIT): string {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
	const record = args as Record<string, unknown>;
	const keys = PRIMARY_ARGUMENT[toolName];
	const raw = keys === undefined ? firstString(record) : pick(record, keys);
	const text = raw.replace(/\s+/g, " ").trim();
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/** The display line for one tool call: `✓ bash · ls -la`. */
export function formatToolLine(line: ToolLine): string {
	const marker = line.status === "ok" ? "✓" : line.status === "error" ? "✗" : "🔧";
	return line.summary === "" ? `${marker} ${line.name}` : `${marker} ${line.name} · ${line.summary}`;
}

/** The text a tool result carries, when it has any. */
export function resultText(result: unknown): string {
	if (typeof result !== "object" || result === null) return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string" && text !== "") parts.push(text);
	}
	return parts.join("\n");
}

/**
 * The body of a folded tool message: the arguments, then the result.
 *
 * Trimmed to `BODY_LIMIT` characters with a marker, because a chat message is a preview: the full
 * output is in the session transcript and in whatever file the tool wrote.
 */
export function toolBody(args: unknown, result: string, limit = BODY_LIMIT): string {
	const blocks: string[] = [];
	const arguments_ = typeof args === "object" && args !== null ? formatArgs(args as Record<string, unknown>) : "";
	if (arguments_ !== "") blocks.push(arguments_);
	if (result.trim() !== "") blocks.push(result.trim());
	const body = blocks.join("\n\n");
	if (body.length <= limit) return body;
	return `${body.slice(0, Math.max(0, limit - 1))}…`;
}

/** The arguments as one line per key, skipping the ones the summary already showed. */
function formatArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (text === undefined || text === "") continue;
		lines.push(`${key}: ${text}`);
	}
	return lines.join("\n");
}
