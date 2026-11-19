/**
 * Markdown to Telegram MarkdownV2 conversion.
 *
 * Port of hermes' `plugins/platforms/telegram/telegram_markdown.py` (its non-rich send path):
 * code is stashed behind placeholders first and never modified, markdown constructs become
 * MarkdownV2 syntax, and everything else is escaped. GFM pipe tables are rewritten into
 * bold-heading bullet groups first (`convertTableToBullets`).
 *
 * One deliberate difference from the Python: LaTeX macros in prose are left alone, so a backslash
 * in model output survives as escaped literal text instead of becoming a Unicode symbol.
 */

/** Marker standing in for the `**` of a line-start `**>` expandable-quote opener. */
const EXPANDABLE_QUOTE = "\x00EQ\x00";

/** Every character MarkdownV2 requires backslash-escaped outside code spans and fences. */
const MDV2_ESCAPE_RE = /([_*[\]()~`>#+\-=|{}.!\\])/g;

type EmphasisKind = "bold" | "italic";

const EMPHASIS_MARK: Record<EmphasisKind, string> = { bold: "*", italic: "_" };

interface StyleRef {
	kind: EmphasisKind;
	index: number;
}

/** One run of `*` characters: what it has paired and what it has left. */
interface StarToken {
	kind: "d";
	start: number;
	end: number;
	canOpen: boolean;
	canClose: boolean;
	remaining: number;
	/** The openers this run closes, in pairing order. */
	closes: StyleRef[];
	/** The closers this run opens, in pairing order. */
	opens: StyleRef[];
}

interface LiteralToken {
	kind: "t";
	text: string;
}

type Token = LiteralToken | StarToken;

/** A stack of undo steps, so a probe can try a pairing and take it back. */
type Journal = Array<() => void>;

/** Escape Telegram MarkdownV2 special characters with a preceding backslash. */
export function escapeMdv2(text: string): string {
	return text.replace(MDV2_ESCAPE_RE, "\\$1");
}

/** Index of the first value at or after `target`. */
function bisectLeft(values: number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** True when the line beginning at `start` is a blockquote line. */
function lineBeginsQuote(text: string, start: number): boolean {
	return text.startsWith(`${EXPANDABLE_QUOTE}>`, start) || text.startsWith(">", start);
}

/** True when the newline at `pos` closes or opens a quote line (`lineStart` starts the line it closes). */
function borderingQuoteNewline(text: string, pos: number, lineStart: number): boolean {
	return lineBeginsQuote(text, lineStart) || lineBeginsQuote(text, pos + 1);
}

/**
 * Sorted line edges of one text, so delimiter pairing answers its span questions by bisect.
 *
 * Re-slicing `text[o_end:start]` and re-finding its newlines for every candidate pair cost
 * closers × span: one distant unmatched `**` opener made a 32 KB reply take ~1.4 s on the
 * gateway event loop.
 */
class SpanEdges {
	readonly newlines: number[];
	readonly blankStarts: number[];
	readonly quoteEdges: number[];

	constructor(text: string) {
		const newlines: number[] = [];
		for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) newlines.push(i);
		this.newlines = newlines;
		this.blankStarts = newlines.filter((pos) => text.startsWith("\n", pos + 1));
		const edges: number[] = [];
		let lineStart = 0;
		for (const pos of newlines) {
			if (borderingQuoteNewline(text, pos, lineStart)) edges.push(pos);
			lineStart = pos + 1;
		}
		this.quoteEdges = edges;
	}

	/** A newline inside `text[start:end]`. */
	hasNewline(start: number, end: number): boolean {
		const i = bisectLeft(this.newlines, start);
		return i < this.newlines.length && this.newlines[i] < end;
	}

	/** A `\n\n` fully inside `text[start:end]`. */
	hasBlankLine(start: number, end: number): boolean {
		const i = bisectLeft(this.blankStarts, start);
		return i < this.blankStarts.length && this.blankStarts[i] + 2 <= end;
	}

	/** A newline inside `text[start:end]` bordering a quote line. */
	crossesQuoteEdge(start: number, end: number): boolean {
		const i = bisectLeft(this.quoteEdges, start);
		return i < this.quoteEdges.length && this.quoteEdges[i] < end;
	}
}

/**
 * The delimiter token for the `*` run `text[start:end]`, or `null` when it is one escaped star.
 */
function starToken(text: string, start: number, end: number): StarToken | null {
	let slash = start;
	while (slash > 0 && text[slash - 1] === "\\") slash -= 1;
	let adjusted = start;
	if ((start - slash) % 2) {
		adjusted = start + 1; // a backslash-escaped * is literal text (**Use \*args**)
		if (adjusted === end) return null;
	}
	const before = adjusted > 0 ? text[adjusted - 1] : "";
	const after = end < text.length ? text[end] : "";
	return {
		kind: "d",
		start: adjusted,
		end,
		canOpen: after !== "" && !/\s/.test(after),
		canClose: before !== "" && !/\s/.test(before),
		remaining: end - adjusted,
		closes: [],
		opens: [],
	};
}

/** Live openers a URL mark run may close at once (`~~**x/**~~`). */
const CLOSER_LOOKBACK = 8;

/**
 * CommonMark's rule of 3: when either run can both open and close, the two may not pair if their
 * lengths sum to a multiple of 3 unless both are multiples of 3. Without it the `*` of `2*3`
 * closed one star of a `**` opener, so `**2*3 = 6**` turned italic and lost its `*`.
 */
function ruleOfThreeRefuses(opener: StarToken, closer: StarToken): boolean {
	const openerLength = opener.end - opener.start;
	const closerLength = closer.end - closer.start;
	return (
		(opener.canClose || closer.canOpen) &&
		(openerLength + closerLength) % 3 === 0 &&
		(openerLength % 3 !== 0 || closerLength % 3 !== 0)
	);
}

/** Italic stays on one line; bold stays within one paragraph and on one side of a quote edge. */
function spanAllows(edges: SpanEdges, opener: StarToken, closer: StarToken): boolean {
	if (opener.remaining >= 2 && closer.remaining >= 2) {
		return !(edges.hasBlankLine(opener.end, closer.start) || edges.crossesQuoteEdge(opener.end, closer.start));
	}
	return !edges.hasNewline(opener.end, closer.start);
}

/**
 * The `*` run pairing rules as incremental state, shared by emphasis pairing and the bare-URL scan
 * so both split and pair a run the same way (`***a* b**` closes one star, then two).
 *
 * `feed` pairs a run for real; `probe` asks what a run would close and records every change in a
 * journal that `rollback` undoes, so a URL's mark run can be tried as a closer.
 */
class StarPairing {
	readonly tokens: Token[];
	readonly edges: SpanEdges;
	private readonly stack: number[] = [];
	private readonly near2: number[] = [];
	private readonly bottoms = new Map<string, number>();

	constructor(tokens: Token[], text: string) {
		this.tokens = tokens;
		this.edges = new SpanEdges(text);
	}

	/** Pair `tokens[idx]` with open runs, then keep its unpaired remainder open. */
	feed(idx: number): StyleRef[] {
		const tok = this.tokens[idx] as StarToken;
		const pairs = this.close(tok, idx, 0, null);
		if (tok.remaining > 0 && tok.canOpen) {
			this.stack.push(idx);
			const lastNear = this.near2.length > 0 ? this.near2[this.near2.length - 1] : -1;
			this.near2.push(tok.remaining >= 2 ? this.stack.length - 1 : lastNear);
		}
		return pairs;
	}

	/** The pairs `tok` would close among the top openers; `tok` keeps what it could not pair. */
	probe(tok: StarToken, journal: Journal): StyleRef[] {
		const snapshot = new Map(this.bottoms);
		journal.push(() => {
			this.bottoms.clear();
			for (const [key, value] of snapshot) this.bottoms.set(key, value);
		});
		return this.close(tok, null, Math.max(0, this.stack.length - CLOSER_LOOKBACK), journal);
	}

	rollback(journal: Journal): void {
		for (let i = journal.length - 1; i >= 0; i -= 1) journal[i]();
		journal.length = 0;
	}

	private close(tok: StarToken, idx: number | null, lowest: number, journal: Journal | null): StyleRef[] {
		const { stack, near2 } = this;
		const pairs: StyleRef[] = [];
		while (tok.canClose && tok.remaining > 0 && stack.length > lowest) {
			const depth = this.pickOpener(tok, lowest);
			if (depth === null) break;
			this.cut(depth + 1, journal); // openers between the pair stay literal (CommonMark)
			const opener = this.tokens[stack[stack.length - 1]] as StarToken;
			const use = opener.remaining >= 2 && tok.remaining >= 2 ? 2 : 1;
			const kind: EmphasisKind = use === 2 ? "bold" : "italic";
			pairs.push({ kind, index: stack[stack.length - 1] });
			if (journal === null && idx !== null) {
				opener.opens.push({ kind, index: idx });
				tok.closes.push({ kind, index: stack[stack.length - 1] });
			} else {
				const restore = opener.remaining;
				journal?.push(() => {
					opener.remaining = restore;
				});
			}
			opener.remaining -= use;
			tok.remaining -= use;
			if (opener.remaining === 0) {
				this.cut(stack.length - 1, journal);
			} else if (opener.remaining < 2) {
				const slot = near2.length - 1;
				const previous = near2[slot];
				journal?.push(() => {
					near2[slot] = previous;
				});
				near2[slot] = near2.length > 1 ? near2[near2.length - 2] : -1;
			}
		}
		return pairs;
	}

	/**
	 * Stack slot of the opener `closer` pairs with, or `null`.
	 *
	 * The nearest opener the rule of 3 allows wins, as in CommonMark, except that a bare `**`
	 * closer reaches past single-`*` openers to a `**` opener: chat text means `**rm -rf *.tmp**`
	 * as bold around a literal `*`. A failed search records how far down it looked for closers of
	 * the same class, so a long run of refused openers is walked once, not once per closer.
	 */
	private pickOpener(closer: StarToken, lowest: number): number | null {
		const { stack, near2, tokens } = this;
		const key = `${(closer.end - closer.start) % 3},${closer.canOpen}`;
		const floor = this.bottoms.get(key) ?? -1;
		let nearest: number | null = null;
		let complete = lowest === 0;
		for (let depth = stack.length - 1; depth >= lowest; depth -= 1) {
			if (stack[depth] <= floor) {
				complete = true;
				break;
			}
			if (!ruleOfThreeRefuses(tokens[stack[depth]] as StarToken, closer)) {
				nearest = depth;
				break;
			}
		}
		if (nearest === null) {
			if (complete && stack.length > 0) this.bottoms.set(key, stack[stack.length - 1]);
			return null;
		}
		const candidates = [nearest];
		if (
			closer.end - closer.start === 2 &&
			closer.remaining === 2 &&
			(tokens[stack[nearest]] as StarToken).remaining < 2 &&
			near2[nearest] >= 0
		) {
			if (near2[nearest] < lowest) return null;
			const double = tokens[stack[near2[nearest]]] as StarToken;
			if (!ruleOfThreeRefuses(double, closer)) candidates.unshift(near2[nearest]);
		}
		for (const depth of candidates) {
			if (spanAllows(this.edges, tokens[stack[depth]] as StarToken, closer)) return depth;
		}
		return null;
	}

	private cut(keep: number, journal: Journal | null): void {
		const { stack, near2 } = this;
		if (journal !== null && keep < stack.length) {
			const stackTail = stack.slice(keep);
			const nearTail = near2.slice(keep);
			journal.push(() => {
				stack.push(...stackTail);
				near2.push(...nearTail);
			});
		}
		stack.length = Math.min(stack.length, keep);
		near2.length = Math.min(near2.length, keep);
	}
}

/** The tokens of `text`, each `*` delimiter run carrying its pairings and unpaired remainder. */
function pairEmphasis(text: string): Token[] {
	const tokens: Token[] = [];
	let pos = 0;
	for (const match of text.matchAll(/\*+/g)) {
		const start = match.index ?? 0;
		const tok = starToken(text, start, start + match[0].length);
		if (tok === null) continue;
		if (tok.start > pos) tokens.push({ kind: "t", text: text.slice(pos, tok.start) });
		tokens.push(tok);
		pos = start + match[0].length;
	}
	if (pos < text.length) tokens.push({ kind: "t", text: text.slice(pos) });
	const pairing = new StarPairing(tokens, text);
	for (let idx = 0; idx < tokens.length; idx += 1) {
		if (tokens[idx].kind === "d") pairing.feed(idx);
	}
	return tokens;
}

/**
 * The style kinds a delimiter run closes (innermost first) and opens (outermost first).
 *
 * A style that is the last to close and the first to reopen at one run continues unbroken;
 * emitting both marks would read as `__` (underline) or an empty bold to Telegram.
 */
function emphasisMarks(tok: StarToken, depth: Record<EmphasisKind, number>): [EmphasisKind[], EmphasisKind[]] {
	const closes = tok.closes.map((ref) => ref.kind);
	const opens = [...tok.opens].reverse().map((ref) => ref.kind);
	for (const kind of ["bold", "italic"] as const) {
		const closesWithKind = closes.filter((value) => value === kind).length;
		if (closes[closes.length - 1] === kind && opens[0] === kind && closesWithKind === depth[kind]) {
			closes.splice(closes.indexOf(kind), 1);
			opens.splice(opens.indexOf(kind), 1);
		}
	}
	return [closes, opens];
}

/**
 * Emit each delimiter's own boundary marks so combined runs that end at different places
 * (`***a* b**`) keep every closing mark. MarkdownV2 cannot nest an entity inside itself, so a kind
 * already open adds no further marks (`****x****` to `*x*`). Each outermost emphasized span is
 * escaped and stashed whole, so later passes cannot cross it.
 */
function renderEmphasis(tokens: Token[], stash: (value: string) => string): string {
	const depth: Record<EmphasisKind, number> = { bold: 0, italic: 0 };
	const parts: string[] = [];
	let group: string[] | null = null;

	const emitLiteral = (value: string): void => {
		if (group === null) parts.push(value);
		else group.push(escapeMdv2(value));
	};

	for (const tok of tokens) {
		if (tok.kind === "t") {
			emitLiteral(tok.text);
			continue;
		}
		const [closes, opens] = emphasisMarks(tok, depth);
		for (const kind of closes) {
			depth[kind] -= 1;
			if (depth[kind] === 0 && group !== null) group.push(EMPHASIS_MARK[kind]);
		}
		if (group !== null && depth.bold === 0 && depth.italic === 0) {
			parts.push(stash(group.join("")));
			group = null;
		}
		emitLiteral("*".repeat(tok.remaining));
		for (const kind of opens) {
			if (group === null) group = [];
			if (depth[kind] === 0) group.push(EMPHASIS_MARK[kind]);
			depth[kind] += 1;
		}
	}
	return parts.join("");
}

/** A link target Telegram can open: a scheme URL (https:, tg:, mailto:) or a bare domain. */
const RENDERABLE_LINK_TARGET_RE = /^(?:[a-z][a-z0-9+.-]*:[^\s@]\S*|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#:]\S*)?)$/i;

const MD_LINK_RE = /\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

/** Whether Telegram can open `target`; a schemeless title is shown as raw syntax instead. */
export function linkTargetRenders(target: string): boolean {
	return RENDERABLE_LINK_TARGET_RE.test(target.trim());
}

/**
 * True when a newline in `text[start:end]` borders a quote line: Telegram ends a blockquote at a
 * newline into non-quote text, an entity still open there is rejected, and an entity spanning
 * quote lines would swallow the next line's `>` marker. A span with no newline cannot cross one, so
 * the prefix scan that locates the enclosing line only runs once a newline is present.
 */
function crossesQuoteEdge(text: string, start: number, end: number): boolean {
	let pos = text.indexOf("\n", start);
	if (pos < 0 || pos >= end) return false;
	let lineStart = text.lastIndexOf("\n", start - 1) + 1;
	while (pos >= 0 && pos < end) {
		if (borderingQuoteNewline(text, pos, lineStart)) return true;
		lineStart = pos + 1;
		pos = text.indexOf("\n", lineStart);
	}
	return false;
}

/** A bare scheme URL; trailing punctuation is prose, not URL. */
const BARE_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>\x00]+/gi;

const URL_TAIL_CHARS = ".,;:!?'\"";
const URL_MARK_RUN_RE = /[*~|]+/g;
const URL_PROSE_AFTER = new Set(".,;:!?'\")]}".split(""));
/** Prose delimiters the URL scan tracks: paragraph breaks, line breaks, `*` runs, strike, spoiler. */
const PROSE_MARK_RE = /\n\n+|\n|\*+|~~|\|\|/g;

/**
 * Length of `url` without trailing prose punctuation; a `)` stays only while it closes a `(`.
 * One pass: the paren balance is counted once and updated while trimming.
 */
function urlEnd(url: string): number {
	let end = url.length;
	let unclosed = 0;
	for (const ch of url) {
		if (ch === ")") unclosed += 1;
		else if (ch === "(") unclosed -= 1;
	}
	while (end > 0) {
		const ch = url[end - 1];
		if (ch === ")" && unclosed > 0) unclosed -= 1;
		else if (ch === "(") {
			unclosed += 1;
			break;
		} else if (!URL_TAIL_CHARS.includes(ch)) break;
		end -= 1;
	}
	return end;
}

/** True when `text[pos]` follows an odd run of backslashes. */
function escapedAt(text: string, pos: number): boolean {
	let slash = pos;
	while (slash > 0 && text[slash - 1] === "\\") slash -= 1;
	return (pos - slash) % 2 === 1;
}

/** True when what follows the URL inside its own match is prose rather than more URL. */
function proseFollows(url: string, end: number): boolean {
	const next = url.slice(end, end + 1);
	return next === "" || URL_PROSE_AFTER.has(next) || !/^[\x00-\x7f]$/.test(next);
}

/**
 * An emphasis/strike/spoiler opener seen in prose, and the URL mark run that may close it.
 * `mark` is `~~`/`||`, or the token index of a `*` run (its stars left live in the token).
 */
interface UrlOpener {
	mark: string | number;
	alive: boolean;
	/** `[active, urlStart, urlStop]` of its fallback closer, once a URL mark run would close it. */
	close: [boolean, number, number] | null;
	/** Its URL closer would pair every star it has left. */
	spent: boolean;
}

/**
 * One rule decides where each bare URL ends: a mark run inside a URL is URL text unless it closes
 * emphasis that opened in prose before the URL. Left to right, prose delimiters keep a stack of
 * open marks; `*` runs pair through `StarPairing`, the rules the renderer uses, so a run may close
 * part of an opener (`***bold* https://x/**`). In a URL, the first mark run that closes the
 * innermost open marks exactly and has prose after it (`**https://x/a**,next`) is that emphasis's
 * fallback closer. A later prose closer of the same emphasis wins unless the URL run would have
 * spent that opener's stars; an opener left unclosed when its line/paragraph ends, or when an
 * enclosing emphasis closes over it, takes its fallback, and the URL ends there. Every other mark
 * is URL text. One pass, linear.
 */
class UrlEmphasisScan {
	private readonly text: string;
	private readonly stack: UrlOpener[] = [];
	private byMark = new Map<string, UrlOpener[]>();
	private readonly tokens: Token[] = [];
	private readonly stars: StarPairing;
	private readonly starOpeners = new Map<number, UrlOpener>();
	private readonly ends = new Map<number, number>();

	constructor(text: string) {
		this.text = text;
		this.stars = new StarPairing(this.tokens, text);
	}

	run(urls: Array<{ start: number; end: number }>): Map<number, number> {
		let pos = 0;
		for (const url of urls) {
			this.scanProse(pos, url.start);
			this.scanUrl(url.start, this.text.slice(url.start, url.end));
			pos = url.end;
		}
		this.scanProse(pos, this.text.length);
		this.release(this.stack);
		return this.ends;
	}

	private scanProse(start: number, end: number): void {
		if (end <= start) return;
		const segment = this.text.slice(start, end);
		for (const match of segment.matchAll(PROSE_MARK_RE)) {
			const tok = match[0];
			const at = start + (match.index ?? 0);
			if (tok[0] === "\n") {
				this.release(tok.length > 1 ? this.stack : this.singleLineOpeners());
			} else if (tok[0] === "*") {
				this.starRun(at, at + tok.length);
			} else if (!(at > 0 && this.text[at - 1] === "\\")) {
				this.delimiter(tok); // an escaped mark is literal
			}
		}
	}

	/** Openers a newline ends: strike, spoiler, and `*` runs with other than two stars left. */
	private singleLineOpeners(): UrlOpener[] {
		const out = [...(this.takeBucket("~~") ?? []), ...(this.takeBucket("||") ?? [])];
		const stars = this.takeBucket("*") ?? [];
		// A run filed under `*` that is down to two stars is filed under `**` too: it survives.
		return out.concat(stars.filter((opener) => (this.tokens[opener.mark as number] as StarToken).remaining !== 2));
	}

	private takeBucket(mark: string): UrlOpener[] | undefined {
		const bucket = this.byMark.get(mark);
		this.byMark.delete(mark);
		return bucket;
	}

	private starRun(start: number, end: number): void {
		const tok = starToken(this.text, start, end);
		if (tok === null) return;
		const idx = this.tokens.length;
		this.tokens.push(tok);
		for (const pair of this.stars.feed(idx)) {
			const opener = this.starOpeners.get(pair.index);
			if (opener === undefined || !opener.alive) continue;
			this.unwind(opener);
			const openerTok = this.tokens[pair.index] as StarToken;
			if (opener.close !== null && (openerTok.remaining === 0 || !opener.spent)) opener.close[0] = false;
			if (openerTok.remaining === 0) {
				opener.alive = false;
				this.stack.pop();
			} else {
				this.fileStar(opener);
			}
		}
		if (tok.remaining > 0 && tok.canOpen) {
			const opener: UrlOpener = { mark: idx, alive: true, close: null, spent: false };
			this.starOpeners.set(idx, opener);
			this.stack.push(opener);
			this.fileStar(opener);
		}
	}

	/** File a `*` opener by what a newline does to it; a run is refiled as it loses stars. */
	private fileStar(opener: UrlOpener): void {
		const bucket = (this.tokens[opener.mark as number] as StarToken).remaining === 2 ? "**" : "*";
		const list = this.byMark.get(bucket);
		if (list === undefined) this.byMark.set(bucket, [opener]);
		else list.push(opener);
	}

	private unwind(target: UrlOpener): void {
		while (this.stack.length > 0 && this.stack[this.stack.length - 1] !== target) {
			this.release([this.stack.pop() as UrlOpener]); // an opener inside the closed span stays unclosed
		}
	}

	private delimiter(mark: string): void {
		const same = this.byMark.get(mark) ?? [];
		while (same.length > 0 && !same[same.length - 1].alive) same.pop();
		const target = same.pop();
		if (target !== undefined) {
			this.unwind(target);
			this.stack.pop();
			target.alive = false;
			if (target.close !== null) target.close[0] = false; // prose closed it: the URL run stays URL text
			return;
		}
		const opener: UrlOpener = { mark, alive: true, close: null, spent: false };
		this.stack.push(opener);
		const list = this.byMark.get(mark);
		if (list === undefined) this.byMark.set(mark, [opener]);
		else list.push(opener);
	}

	private scanUrl(start: number, url: string): void {
		for (const run of url.matchAll(URL_MARK_RUN_RE)) {
			const runStart = run.index ?? 0;
			const runEnd = runStart + run[0].length;
			if (!proseFollows(url, runEnd)) continue;
			// A backslash-escaped mark is URL text (`https://x/a\**`): only the marks after it may close.
			const from = runStart + (escapedAt(url, runStart) ? 1 : 0);
			if (from === runEnd) continue;
			const openers = this.innermost(start + from, url.slice(from, runEnd));
			if (openers.length === 0) continue;
			const fallback: [boolean, number, number] = [true, start, start + urlEnd(url.slice(0, from))];
			for (const opener of openers) opener.close = fallback;
			return;
		}
	}

	/**
	 * The live openers, innermost first, that `run` (at text offset `at`) closes, or `[]`. Every
	 * mark must pair except stars left over at its end; pairing may reach past openers it leaves
	 * literal (`**rm *x https://x/y**`).
	 */
	private innermost(at: number, run: string): UrlOpener[] {
		while (this.stack.length > 0 && !this.stack[this.stack.length - 1].alive) this.stack.pop();
		const live = this.stack
			.slice(-1 - CLOSER_LOOKBACK)
			.reverse()
			.filter((opener) => opener.alive);
		const taken: UrlOpener[] = [];
		const journal: Journal = [];
		let pos = 0;
		let reach = 0;
		try {
			while (pos < run.length) {
				let closed: UrlOpener[] | null;
				if (run[pos] === "*") {
					let stars = 0;
					while (pos + stars < run.length && run[pos + stars] === "*") stars += 1;
					const [openers, spare] = this.starCloses(at + pos, at + pos + stars, journal);
					pos += stars;
					if (spare && pos < run.length) return []; // stars left over end the closing run
					closed = openers;
				} else {
					const next = reach < live.length ? live[reach] : null;
					closed =
						next !== null && typeof next.mark === "string" && run.startsWith(next.mark, pos) ? [next] : null;
					pos += 2;
				}
				if (closed === null || closed.some((o) => o.close !== null || !live.slice(reach).includes(o))) return [];
				if (
					pos < run.length &&
					closed.some((o) => typeof o.mark === "number" && (this.tokens[o.mark] as StarToken).remaining > 0)
				) {
					return []; // a partly closed run must be the last thing this URL run closes
				}
				reach = Math.max(...closed.map((o) => live.indexOf(o))) + 1;
				taken.push(...closed);
			}
			for (const opener of taken) {
				opener.spent = typeof opener.mark === "string" || (this.tokens[opener.mark] as StarToken).remaining === 0;
			}
			return taken;
		} finally {
			this.stars.rollback(journal);
		}
	}

	/**
	 * The `*` openers, innermost first, a URL star run `text[start:end]` pairs with (`null` for
	 * none), and whether stars are left over.
	 */
	private starCloses(start: number, end: number, journal: Journal): [UrlOpener[] | null, boolean] {
		const tok = starToken(this.text, start, end);
		if (tok === null) return [null, false];
		const pairs = this.stars.probe(tok, journal);
		const openers: UrlOpener[] = [];
		for (const pair of pairs) {
			const opener = this.starOpeners.get(pair.index);
			if (opener !== undefined && !openers.includes(opener)) openers.push(opener);
		}
		return [openers.length > 0 ? openers : null, tok.remaining > 0];
	}

	/** `openers` end unclosed by prose: each takes its URL fallback closer, if it still has one. */
	private release(openers: UrlOpener[]): void {
		for (const opener of openers) {
			if (opener.alive && opener.close !== null && opener.close[0] && !this.ends.has(opener.close[1])) {
				this.ends.set(opener.close[1], opener.close[2]);
			}
			opener.alive = false;
		}
		if (openers === this.stack) {
			this.stack.length = 0;
			this.byMark = new Map();
		}
	}
}

/**
 * Stash bare URLs escaped whole, so a `*`, `~~` or `||` inside one stays literal URL text instead
 * of pairing into italic/strike/spoiler marks that drop characters or hide the URL; only a run
 * closing emphasis opened before the URL is released.
 */
function stashBareUrls(text: string, stash: (value: string) => string): string {
	const urls: Array<{ start: number; end: number }> = [];
	for (const match of text.matchAll(BARE_URL_RE)) {
		const start = match.index ?? 0;
		urls.push({ start, end: start + match[0].length });
	}
	if (urls.length === 0) return text;
	const ends = new UrlEmphasisScan(text).run(urls);
	const out: string[] = [];
	let pos = 0;
	for (const url of urls) {
		const matched = text.slice(url.start, url.end);
		const stop = ends.get(url.start) ?? url.start + urlEnd(matched);
		out.push(text.slice(pos, url.start), stash(escapeMdv2(text.slice(url.start, stop))));
		pos = stop;
	}
	return out.join("") + text.slice(pos);
}

/**
 * Stash inline code spans: a backtick run opens a span that the next run of the same width on the
 * same line closes (CommonMark), so runs inside an open span are content, not new spans.
 *
 * Telegram code spans are single-backtick, so a span keeps its content verbatim with `` ` `` and
 * `\` escaped. A ` ``...`` ` span whose content holds backticks, or a triple run, keeps its outer
 * ticks as literal text and its content is scanned for spans of its own.
 */
function stashInlineCode(text: string, stash: (value: string) => string): string {
	const runs: Array<{ start: number; end: number }> = [];
	for (const match of text.matchAll(/`+/g)) {
		const start = match.index ?? 0;
		runs.push({ start, end: start + match[0].length });
	}
	const breaks: number[] = [];
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (code === 13 || code === 10) breaks.push(i);
	}
	breaks.push(text.length);

	const nextSame: Array<number | null> = new Array(runs.length).fill(null);
	const last = new Map<number, number>();
	for (let k = runs.length - 1; k >= 0; k -= 1) {
		const width = runs[k].end - runs[k].start;
		nextSame[k] = last.get(width) ?? null;
		last.set(width, k);
	}

	const literal = new Set<number>();
	const out: string[] = [];
	let pos = 0;
	let i = 0;
	while (i < runs.length) {
		const opener = runs[i];
		const width = opener.end - opener.start;
		let close: number | null = nextSame[i];
		if (close !== null && runs[close].start > breaks[bisectLeft(breaks, opener.end)]) close = null; // never crosses a line
		if (literal.has(i) || close === null) {
			i += 1;
			continue;
		}
		const content = text.slice(opener.end, runs[close].start);
		if (width > 2 || (width === 2 && content.includes("`"))) {
			literal.add(close);
			i += 1;
			continue;
		}
		out.push(text.slice(pos, opener.start));
		out.push(stash(`\`${content.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``));
		pos = runs[close].end;
		i = close + 1;
	}
	out.push(text.slice(pos));
	return out.join("");
}

/**
 * Escape a bare `(`, `)` or `{`, `}` unless it is already escaped or delimits a `[text](url)` link.
 */
function escapeBareBracket(ch: string, s: number, seg: string): string {
	if (s > 0 && seg[s - 1] === "\\") return ch; // already escaped
	if (ch === "(" && s > 0 && seg[s - 1] === "]") return ch; // opens a link [text](url)
	if (ch === ")") {
		// closes a link URL? walk back matching depth
		const before = seg.slice(0, s);
		if (before.includes("](http") || before.includes("](")) {
			let depth = 0;
			for (let j = s - 1; j >= Math.max(s - 2000, 0); j -= 1) {
				if (seg[j] === "(") {
					depth -= 1;
					if (depth < 0) {
						if (j > 0 && seg[j - 1] === "]") return ch;
						break;
					}
				} else if (seg[j] === ")") {
					depth += 1;
				}
			}
		}
	}
	return `\\${ch}`;
}

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$/;
const CONTRACTION_TAIL_RE = /(?:[stdm]|ll|re|ve)(?![A-Za-z])/iy;

/** Whether `line` could plausibly be a table data row. */
function isTableRow(line: string): boolean {
	return line.trim().includes("|");
}

/** The backtick run `row[start:end]` is a whole cell: whitespace, then a pipe or the row edge, both sides. */
function fillsCell(row: string, start: number, end: number): boolean {
	let left = start;
	while (left > 0 && /\s/.test(row[left - 1])) left -= 1;
	let right = end;
	while (right < row.length && /\s/.test(row[right])) right += 1;
	return (
		(left === 0 || (row[left - 1] === "|" && left < start)) &&
		(right === row.length || (row[right] === "|" && right > end))
	);
}

function isSpace(row: string, pos: number): boolean {
	return pos < 0 || pos >= row.length || /\s/.test(row[pos]);
}

/** `row[start:end]` is one backtick typed for an apostrophe inside an ASCII word (`don`t`). */
function isApostrophe(row: string, start: number, end: number): boolean {
	if (end - start !== 1 || start === 0) return false;
	const previous = row[start - 1];
	if (!/^[A-Za-z]$/.test(previous)) return false;
	CONTRACTION_TAIL_RE.lastIndex = end;
	return CONTRACTION_TAIL_RE.test(row);
}

/**
 * A backtick pair that crosses a spaced pipe without being code: an opener typed as an apostrophe
 * (`don`t | it`s`), an opener ending the word before it (`foo` | `), a closer starting the word
 * after it (` | `x`), or both runs alone in their cells.
 */
function notACodeSpan(row: string, opener: number, openerEnd: number, closingEnd: number): boolean {
	const closer = closingEnd - (openerEnd - opener);
	return (
		isApostrophe(row, opener, openerEnd) ||
		(isSpace(row, openerEnd) && !isSpace(row, opener - 1) && row[opener - 1] !== "|") ||
		(isSpace(row, closer - 1) && !isSpace(row, closingEnd)) ||
		(fillsCell(row, opener, openerEnd) && fillsCell(row, closer, closingEnd))
	);
}

/** Split a GFM table row into stripped cells on unescaped pipes outside matched inline-code spans. */
function splitTableRow(row: string): string[] {
	// Pre-index runs by delimiter width: unmatched backticks must not rescan the rest of the row.
	const nextRun = new Map<number, number>();
	const matchingEnds = new Map<number, number>();
	let scan = row.length - 1;
	while (scan >= 0) {
		if (row[scan] !== "`") {
			scan -= 1;
			continue;
		}
		const end = scan + 1;
		while (scan >= 0 && row[scan] === "`") scan -= 1;
		const start = scan + 1;
		const width = end - start;
		// The opener left after an escaped first tick.
		if (width > 1 && nextRun.has(width - 1)) matchingEnds.set(start + 1, nextRun.get(width - 1) as number);
		if (nextRun.has(width)) matchingEnds.set(start, nextRun.get(width) as number);
		nextRun.set(width, end);
	}

	// A span may hold a spaced pipe (`\`ls | grep x\``), but backticks used as apostrophes in two
	// cells (`don`t | it`s`) never pair across one.
	const cellEdges: number[] = [];
	for (let i = 0; i + 2 < row.length; i += 1) if (row.startsWith(" | ", i)) cellEdges.push(i + 1);

	const separators: number[] = [];
	let i = 0;
	while (i < row.length) {
		if (row[i] === "\\") {
			const slashStart = i;
			while (i < row.length && row[i] === "\\") i += 1;
			if ((i - slashStart) % 2 && i < row.length) i += 1; // the next character is escaped
			continue;
		}
		if (row[i] === "`") {
			let end = i + 1;
			while (end < row.length && row[end] === "`") end += 1;
			const closingEnd = matchingEnds.get(i);
			if (closingEnd !== undefined) {
				const edge = bisectLeft(cellEdges, end);
				const withinCell = edge === cellEdges.length || cellEdges[edge] >= closingEnd - (end - i);
				if (withinCell || !notACodeSpan(row, i, end, closingEnd)) {
					i = closingEnd;
					continue;
				}
			}
			i = end; // unmatched or cross-cell backticks are literal
			continue;
		}
		if (row[i] === "|") separators.push(i);
		i += 1;
	}

	let start = 0;
	let end = row.length;
	if (separators.length > 0 && row.slice(0, separators[0]).trim() === "") start = separators[0] + 1;
	if (separators.length > 0 && row.slice(separators[separators.length - 1] + 1).trim() === "") {
		end = separators[separators.length - 1];
	}
	if (start > end) return [""];

	const cells: string[] = [];
	let cellStart = start;
	for (const separator of separators) {
		if (start <= separator && separator < end) {
			cells.push(row.slice(cellStart, separator).trim());
			cellStart = separator + 1;
		}
	}
	cells.push(row.slice(cellStart, end).trim());
	return cells;
}

/**
 * Render a GFM table as bold-heading + bullet groups (same alignment logic as Telegram's renderer:
 * without a row-label column the full row is data and the heading bullet is skipped).
 */
function renderTableBlock(block: string[]): string {
	const headers = block.length >= 3 ? splitTableRow(block[0]) : [];
	if (headers.length < 2) return block.join("\n");
	const hasRowLabelColumn = splitTableRow(block[2]).length === headers.length + 1;
	const groups: string[] = [];
	for (let index = 2; index < block.length; index += 1) {
		const rowNumber = index - 1;
		const cells = splitTableRow(block[index]);
		let heading: string;
		let dataCells: string[];
		if (hasRowLabelColumn) {
			heading = cells.length > 0 && cells[0] !== "" ? cells[0] : `Row ${rowNumber}`;
			dataCells = cells.slice(1);
		} else {
			heading = cells.find((cell) => cell !== "") ?? `Row ${rowNumber}`;
			dataCells = cells;
		}
		const padded = dataCells.concat(new Array(headers.length).fill("")).slice(0, headers.length);
		const bullets = headers
			.map((header, k) => ({ header, value: padded[k] }))
			.filter(({ value }) => hasRowLabelColumn || value !== heading)
			.map(({ header, value }) => `• ${header}: ${value}`);
		groups.push([`**${heading}**`, ...bullets].join("\n"));
	}
	return groups.join("\n\n");
}

/** Rewrite GFM pipe tables into bold-heading + bullet groups; fenced code is left alone. */
export function convertTableToBullets(text: string): string {
	if (!text.includes("|") || !text.includes("-")) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let inFence = false;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const isFenceLine = line.trimStart().startsWith("```");
		if (isFenceLine) inFence = !inFence;
		if (
			!inFence &&
			!isFenceLine &&
			line.includes("|") &&
			i + 1 < lines.length &&
			TABLE_SEPARATOR_RE.test(lines[i + 1])
		) {
			let j = i + 2;
			while (j < lines.length && isTableRow(lines[j])) j += 1;
			out.push(renderTableBlock(lines.slice(i, j)));
			i = j;
		} else {
			out.push(line);
			i += 1;
		}
	}
	return out.join("\n");
}

const PLACEHOLDER_RE = /\x00PH\d+\x00/g;

/** Expand every placeholder in `text` from `expanded`, one pass over the text. */
function expandPlaceholders(text: string, expanded: Map<string, string>): string {
	if (!text.includes("\x00")) return text;
	return text.replace(PLACEHOLDER_RE, (match) => expanded.get(match) ?? match);
}

/** Convert standard markdown to Telegram MarkdownV2. */
export function toMarkdownV2(content: string): string {
	if (content === "") return content;
	const placeholders = new Map<string, string>();
	let counter = 0;

	const stash = (value: string): string => {
		const key = `\x00PH${counter}\x00`;
		counter += 1;
		placeholders.set(key, value);
		return key;
	};
	const stashWrap = (open: string, close: string) => {
		return (match: string, inner: string): string => stash(`${open}${escapeMdv2(inner)}${close}`);
	};

	// 0) Rewrite GFM-style pipe tables into Telegram-friendly row groups.
	let text = convertTableToBullets(content);

	// 1) Protect fenced code blocks (``` ... ```). A fence still opens on its own line, but the line
	//    may carry leading whitespace (list-nested code indents fences) or lead-in prose; the
	//    closing fence must sit on its own line, with optional indent and trailing whitespace.
	//    Line anchors are spelled `(?<=^|\n)`/`(?=\n|$)` rather than `^`/`$` in multiline mode: JS
	//    also breaks lines at `\r`, so a fence line ending in `\r` would protect code Python does not.
	text = text.replace(
		/(?<=^|\n)((?:(?!```)[^\n])*)(```[^`\n]*\n)([\s\S]*?)((?<=^|\n)[ \t]*```)[ \t]*\r?(?=\n|$)/g,
		(_match, prefix: string, opening: string, body: string, closing: string) =>
			prefix + stash(opening + body.replace(/\\/g, "\\\\").replace(/`/g, "\\`") + closing),
	);

	// 2) Protect inline code (`...` and GFM's backtick-free ``...``) in one pass.
	text = stashInlineCode(text, stash);

	// 3) Convert markdown links: escape the display text; inside the URL only ')' and '\' escape.
	text = text.replace(MD_LINK_RE, (match: string, label: string, target: string, offset: number) => {
		if (crossesQuoteEdge(text, offset, offset + match.length)) return match; // the quote would cut it
		if (!linkTargetRenders(target)) return stash(escapeMdv2(label)); // Telegram would show raw syntax
		const url = target.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
		return stash(`[${escapeMdv2(label)}](${url})`);
	});
	text = stashBareUrls(text, stash);

	// 4) Headers (## Title) to bold *Title*, stripping redundant ** inside the header.
	text = text.replace(/(?<=^|\n)#{1,6}\s+([^\n]+)(?=\n|$)/g, (_match, inner: string) =>
		stash(`*${escapeMdv2(inner.trim().replace(/\*\*([^\n]+?)\*\*/g, "$1"))}*`),
	);

	// 4b) A line-start **> expandable-quote opener is quote syntax, not a bold delimiter: hide its **
	//     behind a sentinel so step 5 cannot pair it with a later ** in the quoted text.
	text = text.replace(/(?<=^|\n)\*\*(?=>{1,3} )/g, EXPANDABLE_QUOTE);

	// 5) Bold **text** and *italic* resolve together so nested emphasis survives; unmatched markers
	//    stay literal (bullet lists rely on that). 6) Strikethrough. 7) Spoiler kept as-is.
	text = renderEmphasis(pairEmphasis(text), stash);
	text = text.replace(/~~([^\n]+?)~~/g, stashWrap("~", "~"));
	text = text.replace(/\|\|([^\n]+?)\|\|/g, stashWrap("||", "||"));

	// 9) Blockquotes: protect leading > from escaping; expandable quotes (**> starts, || ends the
	//    block's LAST line).
	text = text.replace(
		new RegExp(`(?<=^|\\n)(?:${EXPANDABLE_QUOTE})?>{1,3} [^\\n]+(?=\\n|$)(?:\\n>{1,3} [^\\n]+(?=\\n|$))*`, "g"),
		(block) => {
			const lines = block.split("\n").map((line) => {
				const space = line.indexOf(" ");
				return space < 0 ? [line, ""] : [line.slice(0, space), line.slice(space + 1)];
			});
			const expandable = lines[0][0].startsWith(EXPANDABLE_QUOTE);
			lines[0][0] = lines[0][0].split(EXPANDABLE_QUOTE).join("**");
			const lastContent = lines[lines.length - 1][1];
			const last = expandable && lastContent.endsWith("||") ? lines.length - 1 : -1;
			return lines
				.map(([prefix, body], i) =>
					i === last
						? stash(`${prefix} ${escapeMdv2(body.slice(0, -2))}||`)
						: stash(`${prefix} ${escapeMdv2(body)}`),
				)
				.join("\n");
		},
	);
	// A sentinel left over means the opener had no quote text after all: restore its literal **.
	text = text.split(EXPANDABLE_QUOTE).join("**");

	// 10) Escape remaining special characters in plain text.
	text = escapeMdv2(text);

	// 11) Restore placeholders in one pass: a value only nests keys stashed before it, so expanding
	//     values in insertion order resolves every nesting without one whole-text scan per key.
	const expanded = new Map<string, string>();
	for (const [key, value] of placeholders) expanded.set(key, expandPlaceholders(value, expanded));
	text = expandPlaceholders(text, expanded);

	// 12) Safety net: escape bare ( ) { } that slipped through, but never inside ``` or ` spans.
	const parts = text.split(/(```[\s\S]*?```|`[^`\r\n]+`)/);
	return parts
		.map((segment, index) => {
			if (index % 2 === 1) return segment; // inside code, untouched
			return segment.replace(/[(){}]/g, (ch, offset: number) => escapeBareBracket(ch, offset, segment));
		})
		.join("");
}
