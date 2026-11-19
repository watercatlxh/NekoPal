/**
 * Prompt-injection shapes that must not reach a memory file.
 *
 * A memory entry is injected into the system prompt of every future session, so text that
 * impersonates a prompt section or exfiltrates credentials is rejected at write time.
 */
const PATTERNS: RegExp[] = [
	/ignore (all )?(previous|prior|above) (instructions|rules)/i,
	/disregard .{0,40}(instructions|rules|system prompt)/i,
	/<\/?(system|soul|memory|channel|cron|tools|rules)>/i,
	/(curl|wget)[^\n]*\$\{?[A-Z_]*(KEY|TOKEN|SECRET)/i,
	/cat [^\n]*(auth\.json|\.nekopal\/env)/i,
];

/** The first pattern `text` matches, or undefined when the text is safe to store. */
export function firstThreat(text: string): string | undefined {
	for (const pattern of PATTERNS) {
		if (pattern.test(text)) return pattern.source;
	}
	return undefined;
}
