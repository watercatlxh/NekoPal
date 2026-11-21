/**
 * `web_search`: keyless web search, ported from oh-my-pi's `src/web/search/`.
 *
 * omp drives some engines through puppeteer and a stealth profile; NekoPal has no browser, so every
 * engine here is a plain HTTP fetch with browser headers. The parsers are the same ones, because the
 * markup is what matters and it does not care how the request was made.
 *
 * Two engines: DuckDuckGo's lite frontend is the broadest, and HN's Algolia API covers technical
 * queries. They run in parallel and results are merged by how many engines agreed on a URL, which is
 * omp's ranking rule. Mojeek, Startpage, Ecosia and Brave were tried and rejected: the first serves a
 * JavaScript shell, the second needs a homepage handshake, and the last two answer 403/429 to a
 * datacenter IP.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** One result, after parsing and before ranking. */
interface Hit {
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
}

/** An engine's answer: its hits, or why it failed. */
interface EngineResult {
	readonly hits: readonly Hit[];
	readonly error?: string;
}

/** A browser-like UA; every one of these engines 403s a bare Node client. */
const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Per-engine timeout. The whole call is bounded by the fan-out below, not by this. */
const ENGINE_TIMEOUT_MS = 12_000;
/** How long the fan-out waits before returning what it has. */
const SOFT_DEADLINE_MS = 6_000;
/** Results kept, after merging. */
const DEFAULT_LIMIT = 8;

/** Strip tags, decode the entities these pages emit, and collapse whitespace. */
function text(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

/** A GET with the browser headers these engines expect. */
async function get(url: string, signal: AbortSignal, accept = "text/html"): Promise<string> {
	const response = await fetch(url, {
		headers: {
			"user-agent": USER_AGENT,
			accept,
			"accept-language": "en-US,en;q=0.9",
			"sec-fetch-mode": "navigate",
			"sec-fetch-site": "none",
			"upgrade-insecure-requests": "1",
		},
		signal,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.text();
}

/** Whether a DuckDuckGo page is its bot challenge instead of results. */
function ddgBlocked(html: string): boolean {
	return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

/** DuckDuckGo wraps outbound links in `//duckduckgo.com/l/?uddg=<encoded>`. */
function unwrapDdg(href: string): string | undefined {
	const decoded = href.replace(/&amp;/gi, "&");
	if (/^(?:https?:)?\/\/(?:www\.)?duckduckgo\.com\/y\.js/i.test(decoded)) return undefined;
	const wrapped = /[?&]uddg=([^&]+)/.exec(decoded);
	if (wrapped) {
		try {
			return decodeURIComponent(wrapped[1]);
		} catch {
			return undefined;
		}
	}
	if (decoded.startsWith("//")) return `https:${decoded}`;
	return decoded.startsWith("http") ? decoded : undefined;
}

/**
 * DuckDuckGo's no-JS lite page: each result is an anchor carrying `result-link`, with a
 * `result-snippet` cell beside it. The attributes arrive in either order and either quote style, so
 * the class is matched anywhere in the tag and the href is pulled out separately.
 */
function parseDdgLite(html: string): Hit[] {
	if (ddgBlocked(html)) throw new Error("blocked by a bot challenge");
	const hits: Hit[] = [];
	const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
	const snippets = [...html.matchAll(/<td\b[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g)];
	let snippetIndex = 0;
	for (const anchor of anchors) {
		const attributes = anchor[1];
		if (!/class=['"][^'"]*\bresult-link\b/.test(attributes)) continue;
		const href = /href=['"]([^'"]+)['"]/.exec(attributes);
		if (!href) continue;
		const url = unwrapDdg(href[1]);
		if (!url) continue;
		const title = text(anchor[2]);
		if (title === "") continue;
		const snippet = snippets[snippetIndex] ? text(snippets[snippetIndex][1]) : "";
		snippetIndex += 1;
		hits.push({ title, url, snippet });
	}
	return hits;
}

/** Hacker News through Algolia's public API. */
function parseHackerNews(body: string): Hit[] {
	const parsed: unknown = JSON.parse(body);
	const hits = (parsed as { hits?: unknown }).hits;
	if (!Array.isArray(hits)) return [];
	const results: Hit[] = [];
	for (const entry of hits) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as {
			objectID?: unknown;
			title?: unknown;
			url?: unknown;
			story_title?: unknown;
			comment_text?: unknown;
		};
		const id = typeof record.objectID === "string" ? record.objectID : undefined;
		if (id === undefined) continue;
		const title = typeof record.title === "string" ? record.title : record.story_title;
		if (typeof title !== "string" || title === "") continue;
		const url =
			typeof record.url === "string" && record.url !== ""
				? record.url
				: `https://news.ycombinator.com/item?id=${id}`;
		const snippet = typeof record.comment_text === "string" ? text(record.comment_text) : "";
		results.push({ title, url, snippet: snippet.slice(0, 200) });
	}
	return results;
}

/** One engine: a URL, a parser, and the headers its response needs. */
interface Engine {
	readonly id: string;
	readonly build: (query: string) => string;
	readonly accept: string;
	readonly parse: (body: string) => Hit[];
}

const ENGINES: readonly Engine[] = [
	{
		id: "duckduckgo",
		build: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
		accept: "text/html",
		parse: parseDdgLite,
	},
	{
		id: "hackernews",
		build: (query) => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=10`,
		accept: "application/json",
		parse: parseHackerNews,
	},
];

/** Run one engine, turning any failure into an error string rather than a rejection. */
async function runEngine(engine: Engine, query: string, signal: AbortSignal): Promise<EngineResult> {
	try {
		const body = await get(engine.build(query), signal, engine.accept);
		return { hits: engine.parse(body) };
	} catch (error) {
		return { hits: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** A result plus the evidence that ranks it. */
interface Ranked {
	readonly hit: Hit;
	/** How many engines returned this URL; more agreement ranks higher. */
	engines: number;
	/** The best (lowest) position any engine gave it. */
	rank: number;
	/** Insertion order, so equal results keep a stable order. */
	order: number;
}

/** Case-normalised host without `www.`, trailing slash trimmed, fragment dropped. */
function dedupKey(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
		return `${host}${path}${url.search}`;
	} catch {
		return rawUrl;
	}
}

/** Merge every engine's hits, ranked by agreement then by best position. */
function merge(results: readonly EngineResult[], limit: number): Hit[] {
	const merged = new Map<string, Ranked>();
	for (const result of results) {
		for (const [rank, hit] of result.hits.entries()) {
			const key = dedupKey(hit.url);
			const existing = merged.get(key);
			if (existing === undefined) {
				merged.set(key, { hit, engines: 1, rank, order: merged.size });
				continue;
			}
			existing.engines += 1;
			if (rank < existing.rank) merged.set(key, { hit, engines: existing.engines, rank, order: existing.order });
		}
	}
	return [...merged.values()]
		.sort((left, right) => right.engines - left.engines || left.rank - right.rank || left.order - right.order)
		.slice(0, limit)
		.map((entry) => entry.hit);
}

/** The search body: run every engine in parallel and return what arrived in time. */
export async function search(
	query: string,
	limit: number,
	signal?: AbortSignal,
): Promise<{ text: string; hits: Hit[] }> {
	const timeout = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const straggler = new AbortController();
	const race = AbortSignal.any([combined, straggler.signal]);
	// Each engine writes into `results` as it settles, so a soft deadline can read what is done.
	const results: EngineResult[] = [];
	let settled = 0;
	let finish: (() => void) | undefined;
	const allDone = new Promise<void>((resolve) => {
		finish = resolve;
	});
	for (const engine of ENGINES) {
		void runEngine(engine, query, race).then((result) => {
			results.push(result);
			settled += 1;
			if (settled === ENGINES.length) finish?.();
		});
	}
	const soft = new Promise<"soft">((resolve) => {
		const timer = setTimeout(() => resolve("soft"), SOFT_DEADLINE_MS);
		timer.unref();
	});
	const outcome = await Promise.race([allDone, soft]);
	if (outcome === "soft" && results.length === 0) {
		// Nothing arrived in time: wait for the first engine rather than answer with nothing.
		await Promise.race([allDone, new Promise((resolve) => setTimeout(resolve, ENGINE_TIMEOUT_MS).unref())]);
	}
	straggler.abort();
	const hits = merge(results, limit);
	const failures = results.filter((result) => result.error !== undefined).map((result) => result.error);
	if (hits.length === 0) {
		const reason = failures.length > 0 ? failures.join("; ") : "no results";
		return { text: `No results for "${query}" (${reason})`, hits: [] };
	}
	const lines: string[] = [];
	for (const [index, hit] of hits.entries()) {
		lines.push(`[${index + 1}] ${hit.title}`);
		lines.push(`    ${hit.url}`);
		if (hit.snippet !== "") lines.push(`    ${hit.snippet.slice(0, 240)}`);
	}
	return { text: lines.join("\n"), hits };
}

const parameters = Type.Object({
	query: Type.String({ description: "Search query; supports quotes and site: like a normal engine" }),
	limit: Type.Optional(Type.Number({ description: `Results to return, default ${DEFAULT_LIMIT}` })),
});

/** The `web_search` tool: keyless search over Mojeek, DuckDuckGo and Hacker News. */
export function webSearchTool() {
	return defineTool({
		name: "web_search",
		label: "web_search",
		description:
			"Search the web. Returns numbered results with title, URL and snippet. Use it when the answer depends on current information, or when the user gives a URL or a topic to look up.",
		promptSnippet: "web_search: search the web for current information",
		parameters,
		async execute(_toolCallId: string, params: { query: string; limit?: number }) {
			const limit = params.limit !== undefined && params.limit > 0 ? Math.min(params.limit, 20) : DEFAULT_LIMIT;
			const { text: body } = await search(params.query, limit);
			return { content: [{ type: "text" as const, text: body }], details: undefined };
		},
	});
}
