/**
 * Plain-text fallback for a MarkdownV2 message: strip the escapes and formatting markers Telegram
 * renders, so the same reply can be re-sent without `parse_mode` when the server rejects entities.
 *
 * Port of hermes' `_strip_mdv2` (`plugins/platforms/telegram/telegram_split.py`).
 */

const MDV2_ESCAPE_RE = /\\([_*[\]()~`>#+\-=|{}.!\\])/g;

/** Strip MarkdownV2 escapes and formatting markers for the plain-text fallback. */
export function stripMdv2(text: string): string {
	return text
		.replace(MDV2_ESCAPE_RE, "$1") // unescape
		.replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** before MarkdownV2 *bold*
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1") // italic; word-bounded so snake_case survives
		.replace(/~([^~]+)~/g, "$1") // strikethrough
		.replace(/\|\|([^|]+)\|\|/g, "$1"); // spoiler
}
