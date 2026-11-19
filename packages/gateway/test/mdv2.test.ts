import { describe, expect, it } from "vitest";
import { convertTableToBullets, toMarkdownV2 } from "../src/channel/telegram/mdv2.ts";
import { stripMdv2 } from "../src/channel/telegram/strip.ts";

/**
 * The Bot API's MarkdownV2 entity parser, in the subset Telegram accepts: escapes, code spans and
 * fences, links, the paired style markers, and line-leading `>` / `**>` quotes. Returns the reason
 * a message would be rejected, or `undefined` when it parses.
 */
function mdv2Error(text: string): string | undefined {
	const reserved = new Set("_*[]()~`>#+-=|{}.!".split(""));
	const link = /\[((?:\\.|`(?:\\.|[^`\\])*`|[^\]\\`])*)\]\(((?:\\.|[^)\\])*)\)/y;
	const quoteMarker = /(?:\*\*)?>+/y;
	const openMarks: string[] = [];
	let expandable = false;
	let inQuote = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\n" && inQuote && text[i + 1] !== ">") {
			inQuote = false; // a newline into non-quote text ends the quote and must close every entity in it
			if (openMarks.length > 0)
				return `Can't find end of the entity starting with '${openMarks[openMarks.length - 1]}'`;
		}
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (text.startsWith("```", i)) {
			const end = text.indexOf("```", i + 3);
			if (end < 0) return `Can't find end of Pre entity at byte offset ${i}`;
			i = end + 3;
			continue;
		}
		if (ch === "`") {
			let end = i + 1;
			while (end < text.length && text[end] !== "`") end += text[end] === "\\" ? 2 : 1; // \` and \\ escape inside code
			if (end >= text.length) return `Can't find end of Code entity at byte offset ${i}`;
			i = end + 1;
			continue;
		}
		if (ch === "[") {
			link.lastIndex = i;
			const match = link.exec(text);
			if (match === null || (inQuote && /\n(?!>)/.test(match[0]))) {
				return "Character '[' is reserved and must be escaped with the preceding '\\'";
			}
			i = link.lastIndex;
			continue;
		}
		if (i === 0 || text[i - 1] === "\n") {
			quoteMarker.lastIndex = i;
			const marker = quoteMarker.exec(text);
			if (marker !== null) {
				expandable = expandable || text[i] === "*";
				inQuote = true;
				i = quoteMarker.lastIndex;
				continue;
			}
		}
		if (
			expandable &&
			text.startsWith("||", i) &&
			["", "\n"].includes(text[i + 2] ?? "") &&
			openMarks[openMarks.length - 1] !== "||"
		) {
			// The expandable quote's closer is valid only on the block's last line.
			if (text[i + 3] !== ">") {
				expandable = false;
				i += 2;
				continue;
			}
		}
		const mark = ["||", "__", "*", "_", "~"].find((candidate) => text.startsWith(candidate, i));
		if (mark !== undefined) {
			if (openMarks[openMarks.length - 1] === mark) openMarks.pop();
			else openMarks.push(mark);
			i += mark.length;
			continue;
		}
		if (reserved.has(ch)) return `Character '${ch}' is reserved and must be escaped with the preceding '\\'`;
		i += 1;
	}
	if (openMarks.length > 0) return `Can't find end of the entity starting with '${openMarks[openMarks.length - 1]}'`;
	return undefined;
}

/** Convert and assert the result is valid MarkdownV2. */
function convert(markdown: string): string {
	const out = toMarkdownV2(markdown);
	expect(mdv2Error(out)).toBeUndefined();
	return out;
}

describe("toMarkdownV2", () => {
	describe("combined emphasis closing at different places", () => {
		it.each([
			["***bold* rest**", "*_bold_ rest*"],
			["***bold** rest*", "_*bold* rest_"],
			["**a *b***", "*a _b_*"],
			["*a **b***", "_a *b*_"],
		])("%j", (markdown, expected) => {
			expect(convert(markdown)).toBe(expected);
		});
	});

	describe("expandable quotes", () => {
		it.each([
			// The quoted text opens with **bold**: the opener's ** must not pair with it.
			["**> **Action Plan** 1. **Skill** - do it||", "**> *Action Plan* 1\\. *Skill* \\- do it||"],
			// Multi-line expandable quote: || stays raw on the last line only.
			["**> First\n> **Second**\n> Last||", "**> First\n> *Second*\n> Last||"],
		])("%j", (markdown, expected) => {
			expect(convert(markdown)).toBe(expected);
		});

		it("only a line-start **> is a quote opener; ** before other text is still bold", () => {
			expect(convert("**>5 items** and **a > b**")).toBe("*\\>5 items* and *a \\> b*");
		});
	});

	describe("inline code", () => {
		it.each([
			["`a ``b-c`` d`", "`a \\`\\`b-c\\`\\` d`"],
			["` ``x.y`` `", "` \\`\\`x.y\\`\\` `"],
			// The doubled ticks become a single escaped tick.
			["Use ``value`` now", "Use `value` now"],
		])("%j", (markdown, expected) => {
			expect(convert(markdown)).toBe(expected);
		});

		it("keeps code content verbatim", () => {
			expect(convert("run `ls -la` now")).toBe("run `ls -la` now");
			expect(convert("```py\nprint('a_b')\n```")).toBe("```py\nprint('a_b')\n```");
		});
	});

	describe("emphasis and links never cross a quote line edge", () => {
		it.each(["> **a\nb**", "> **a\n> b**", "> [`\n`]()"])("%j parses", (markdown) => {
			convert(markdown);
		});

		it("leaves an entity spanning a quote edge literal instead of opening it", () => {
			expect(convert("> **a\nb**")).toBe("> \\*\\*a\nb\\*\\*");
			expect(convert("> **a\n> b**")).toBe("> \\*\\*a\n> b\\*\\*");
		});
	});

	describe("link targets Telegram cannot open degrade to the label", () => {
		it.each([
			["Already underway in [Long-Term Fix](Long-Term Fix).", "Already underway in Long\\-Term Fix\\."],
			["See [Run](@session:default/20260101_abc).", "See Run\\."],
			["[Docs](https://example.com/a_b)", "[Docs](https://example.com/a_b)"],
			["[me](tg://user?id=1) [w](example.com)", "[me](tg://user?id=1) [w](example.com)"],
		])("%j", (markdown, expected) => {
			expect(convert(markdown)).toBe(expected);
		});
	});

	describe("bare URLs reach the chat as literal text", () => {
		it.each([
			"http://127.0.0.1:5173/?token=abc123",
			"https://web.archive.org/web/*/example.com/*",
			"http://h.example/p?t=a*b*c",
			"https://x.example/a~~b~~c",
			"http://h.example/x||y||z",
			"https://example.com/a*;b*c",
			"https://example.com/a**,b**c",
			"https://example.com/a*;b*c*",
			"https://x.example/a~~;b~~c~~",
		])("%j", (url) => {
			const out = convert(`Open ${url} now`);
			expect(out.replace(/\\(.)/g, "$1")).toBe(`Open ${url} now`);
			// Every mark inside the URL is escaped, so it never becomes italic/strike/spoiler.
			expect(out).not.toMatch(/(?<!\\)[*_~|]/);
		});

		it("stays whole inside emphasis that wraps it", () => {
			const url = "https://x.example/a*b*c";
			const out = convert(`*Open ${url} now*`);
			expect(out.startsWith("_Open ")).toBe(true);
			expect(out.replace(/\\(.)/g, "$1")).toContain(`Open ${url} now`);
		});
	});

	describe("emphasis wrapping a URL that ends in a slash still renders", () => {
		it.each([
			["*https://example.com/*", "_https://example\\.com/_"],
			["**https://example.com/**", "*https://example\\.com/*"],
			["~~https://example.com/~~", "~https://example\\.com/~"],
			["**bold https://example.com/**", "*bold https://example\\.com/*"],
			["*see https://x.com/docs/*", "_see https://x\\.com/docs/_"],
			["*https://a.example/* and *https://b.example/*", "_https://a\\.example/_ and _https://b\\.example/_"],
			["**x https://a.example/** y **z**", "*x https://a\\.example/* y *z*"],
			[
				"*Open https://archive.example/web/* now* and https://b.example/*",
				"_Open https://archive\\.example/web/\\* now_ and https://b\\.example/\\*",
			],
			["*See https://a.example/x and https://b.example/*", "_See https://a\\.example/x and https://b\\.example/_"],
			['"*https://example.com/*"', '"_https://example\\.com/_"'],
			['"**https://example.com/**"', '"*https://example\\.com/*"'],
			['"~~https://example.com/~~"', '"~https://example\\.com/~"'],
		])("%j", (wrapped, rendered) => {
			expect(convert(`see ${wrapped} ok`)).toBe(`see ${rendered} ok`);
		});
	});

	describe("emphasis around a URL pairs as around any word", () => {
		it.each([
			["**See\nhttps://example.com/**", "*See\nhttps://example\\.com/*"],
			["*outer **https://example.com/** end*", "_outer *https://example\\.com/* end_"],
			["**https://example.com**—next", "*https://example\\.com*—next"],
			["[**https://x.example/**]", "\\[*https://x\\.example/*\\]"],
			["~~https://x.example/a~~,next", "~https://x\\.example/a~,next"],
			["**https://x/a**,next", "*https://x/a*,next"],
			["**https://example.com/a**,next**word**", "*https://example\\.com/a*,next*word*"],
			["*Open https://example.com/a*;b*c* now*", "_Open https://example\\.com/a\\*;b\\*c\\* now_"],
			// A URL run closes part of a mixed opener run, as the renderer's own star pairing does.
			["***bold* https://example.com/**", "*_bold_ https://example\\.com/*"],
			["***a** https://x/y*", "_*a* https://x/y_"],
			["**a *b https://x/c* d**", "*a _b https://x/c_ d*"],
			["**rm *x https://x/y**", "*rm \\*x https://x/y*"],
			// A backslash-escaped star is URL text; only the marks after it may close.
			[String.raw`***Docs https://ex.com/a\** now`, String.raw`\*\*_Docs https://ex\.com/a\\\*_ now`],
			[String.raw`***see https://ex.com/\**, ok`, String.raw`\*\*_see https://ex\.com/\\\*_, ok`],
			[String.raw`**x https://ex.com/a\** z`, String.raw`\*_x https://ex\.com/a\\\*_ z`],
			[String.raw`**a *x https://ex.com/\*** z`, String.raw`*a \*x https://ex\.com/\\\** z`],
		])("%j", (markdown, expected) => {
			expect(convert(markdown)).toBe(expected);
		});
	});

	describe("plain text escaping", () => {
		it("escapes currency punctuation", () => {
			const out = convert("Price is $5.00!");
			expect(out).toContain("\\.");
			expect(out).toContain("\\!");
			expect(out).toBe("Price is $5\\.00\\!");
		});

		it("escapes reserved characters and keeps snake_case readable", () => {
			expect(convert("a_b_c snake_case")).toBe("a\\_b\\_c snake\\_case");
			expect(convert("(paren) {brace} [bracket]")).toBe("\\(paren\\) \\{brace\\} \\[bracket\\]");
		});

		it("escapes a backslash as literal text instead of normalizing LaTeX", () => {
			expect(convert(String.raw`a \to b`)).toBe(String.raw`a \\to b`);
		});

		it("renders headers, lists, strikethrough and spoilers", () => {
			expect(convert("## Sub **bold** head")).toBe("*Sub bold head*");
			expect(convert("- a\n- b *c*")).toBe("\\- a\n\\- b _c_");
			expect(convert("~~gone~~ and ||hidden||")).toBe("~gone~ and ||hidden||");
			expect(convert("*i* **b** ***bi***")).toBe("_i_ *b* _*bi*_");
		});
	});

	describe("tables", () => {
		it("rewrites a pipe table into bold headings and bullets", () => {
			expect(convertTableToBullets("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("**1**\n• b: 2");
			expect(convertTableToBullets("| Name | Value |\n| --- | --- |\n| x | 1 |\n| y | 2 |")).toBe(
				"**x**\n• Value: 1\n\n**y**\n• Value: 2",
			);
		});

		it("leaves a table inside a fence alone", () => {
			const fenced = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
			expect(convertTableToBullets(fenced)).toBe(fenced);
		});
	});

	it("returns an empty string unchanged", () => {
		expect(toMarkdownV2("")).toBe("");
	});

	it("formats a 4 KB input with many unmatched ** without rescanning", () => {
		const text = `**a\n${"plain line here\n".repeat(256)}${"** b ".repeat(512)}`;
		expect(text.length).toBeGreaterThan(4096);
		const started = performance.now();
		convert(text);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	it("scales linearly over unmatched ** openers", () => {
		const build = (lines: number) => `**a\n${"plain line here\n".repeat(lines)}${"> q\n" + "b** \n".repeat(lines)}`;
		const small = build(64);
		const large = build(64 * 8);
		const best = (text: string): number => {
			let fastest = Number.POSITIVE_INFINITY;
			for (let run = 0; run < 3; run += 1) {
				const started = performance.now();
				toMarkdownV2(text);
				fastest = Math.min(fastest, performance.now() - started);
			}
			return fastest;
		};
		best(small); // warm up
		expect(best(large)).toBeLessThan(best(small) * 40 + 50);
	});
});

describe("stripMdv2", () => {
	it("unescapes reserved characters", () => {
		expect(stripMdv2("Price is $5\\.00\\!")).toBe("Price is $5.00!");
		expect(stripMdv2("\\[bracket\\] \\(paren\\) \\{brace\\}")).toBe("[bracket] (paren) {brace}");
	});

	it("strips formatting markers", () => {
		expect(stripMdv2("*bold* _italic_ ~gone~ ||hidden||")).toBe("bold italic gone hidden");
		expect(stripMdv2("**bold** and *italic*")).toBe("bold and italic");
	});

	it("keeps snake_case intact", () => {
		expect(stripMdv2("snake\\_case and _emphasis_")).toBe("snake_case and emphasis");
	});

	it("round-trips a converted reply to readable plain text", () => {
		const plain = "Already underway in Long-Term Fix.";
		expect(stripMdv2(toMarkdownV2(plain))).toBe(plain);
		expect(stripMdv2(toMarkdownV2("**bold** and `code` and ~~gone~~"))).toBe("bold and `code` and gone");
	});
});
