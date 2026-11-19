import { describe, expect, it } from "vitest";
import { splitMarkdown } from "../src/channel/split.ts";

const LIMITS = { maxChars: 3500, maxChunks: 8 };

describe("splitMarkdown", () => {
	it("keeps a short text in one chunk", () => {
		const result = splitMarkdown("hello", LIMITS);
		expect(result.chunks).toEqual(["hello"]);
		expect(result.asDocument).toBe(false);
	});

	it("splits 10000 characters into chunks of at most 3500 that rejoin to the source", () => {
		const text = Array.from({ length: 250 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
		expect(text.length).toBeGreaterThan(10_000);
		const result = splitMarkdown(text, LIMITS);
		expect(result.asDocument).toBe(false);
		expect(result.chunks.length).toBeGreaterThan(1);
		for (const chunk of result.chunks) expect(chunk.length).toBeLessThanOrEqual(3500);
		expect(result.chunks.join("")).toBe(text);
	});

	it("closes and reopens a fence when the break lands inside a code block", () => {
		const body = Array.from({ length: 120 }, (_, index) => `const value${index} = ${index};`).join("\n");
		const text = `Here is the code:\n\n\`\`\`ts\n${body}\n\`\`\`\n\nDone.`;
		const result = splitMarkdown(text, { maxChars: 500, maxChunks: 8 });
		expect(result.asDocument).toBe(false);
		expect(result.chunks.length).toBeGreaterThan(1);
		for (const chunk of result.chunks) {
			const fences = chunk.match(/^```/gm) ?? [];
			expect(fences.length % 2).toBe(0);
		}
		expect(result.chunks.slice(1).some((chunk) => chunk.startsWith("```ts\n"))).toBe(true);
	});

	it("never splits a surrogate pair", () => {
		const text = "😀".repeat(2_000);
		const result = splitMarkdown(text, LIMITS);
		for (const chunk of result.chunks) {
			const last = chunk.charCodeAt(chunk.length - 1);
			expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
		}
		expect(result.chunks.join("")).toBe(text);
	});

	it("asks for a document beyond the chunk limit", () => {
		const result = splitMarkdown("word ".repeat(20_000), { maxChars: 3_500, maxChunks: 8 });
		expect(result.asDocument).toBe(true);
		expect(result.chunks).toEqual([]);
	});
});
