/**
 * Telegram rich messages: standard Markdown plus the constructs MarkdownV2 cannot express.
 *
 * A rich message renders `- item` as a real bullet, `| a | b |` as a table and `<details>` as a
 * fold, none of which MarkdownV2 has syntax for. The payload is the assistant's own Markdown, so
 * this module only has to defuse what would break the markup rather than translate it.
 */

import type { Keyboard } from "../types.ts";

/** Telegram's hard limit for one rich message, in source characters. */
export const RICH_LIMIT = 32_768;

const ZERO_WIDTH = "\u200b";

/**
 * Break every literal `</details` so content cannot close the fold that wraps it.
 *
 * A zero-width space after `<` keeps the text identical on screen while the tag no longer parses.
 */
export function defuseDetails(text: string): string {
	return text.replace(/<\/(details)/gi, `<${ZERO_WIDTH}/$1`);
}

/** The Markdown to send as a rich message. */
export function toRich(markdown: string): string {
	return defuseDetails(markdown);
}

/** A fence long enough that backticks inside `body` cannot close it early. */
export function fence(info: string, body: string): string {
	let longest = 0;
	for (const run of body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
	const marker = "`".repeat(Math.max(3, longest + 1));
	return `${marker}${info}\n${body}\n${marker}`;
}

/** A fold whose summary stays visible and whose body is hidden until tapped. */
export function details(summary: string, body: string): string {
	const head = defuseDetails(summary).replace(/\s+/g, " ").trim();
	if (body.trim() === "") return `<details><summary>${head}</summary>\n\n</details>`;
	return `<details><summary>${head}</summary>\n\n${defuseDetails(body).trim()}\n\n</details>`;
}

/** Telegram's `InlineKeyboardMarkup`, or undefined when there is nothing to show. */
export function keyboardToMarkup(
	keyboard: Keyboard | undefined,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
	if (!keyboard || keyboard.length === 0) return undefined;
	return {
		inline_keyboard: keyboard.map((row) => row.map((button) => ({ text: button.label, callback_data: button.data }))),
	};
}
