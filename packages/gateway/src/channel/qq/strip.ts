const FENCE_RE = /^[ \t]*`{3,}/;
const LINK_RE = /!?\[([^\]]*)\]\(([^()\s]*)\)/g;
const HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+/;
const QUOTE_RE = /^[ \t]{0,3}>[ \t]?/;
const EMPHASIS_RE = /\*\*|__|~~/g;
const CODE_RE = /`/g;

/**
 * Turn Markdown into the plain text QQ accepts when the markdown message type is rejected.
 *
 * Emphasis markers, inline-code backticks, heading hashes and quote arrows are dropped, links keep
 * their target as `label (url)`, and fenced code blocks keep their body without the fences.
 */
export function stripMarkdown(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let inFence = false;

	for (const line of lines) {
		if (FENCE_RE.test(line)) {
			inFence = !inFence;
			continue;
		}
		out.push(inFence ? line : stripLine(line));
	}

	return out.join("\n");
}

function stripLine(line: string): string {
	return line
		.replace(LINK_RE, (_match, label: string, url: string) => (url === "" ? label : `${label} (${url})`))
		.replace(EMPHASIS_RE, "")
		.replace(CODE_RE, "")
		.replace(HEADING_RE, "")
		.replace(QUOTE_RE, "");
}
