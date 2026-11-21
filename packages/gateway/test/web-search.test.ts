import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { search, webSearchTool } from "../src/tools/web-search.ts";

function engines() {
	const ddg = Promise.withResolvers<Response>();
	const hn = Promise.withResolvers<Response>();
	const signals: AbortSignal[] = [];
	vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
		signals.push(init.signal!);
		return url.includes("duckduckgo") ? ddg.promise : hn.promise;
	});
	return { ddg, hn, signals };
}
const ddgPage = (...ids: string[]) =>
	new Response(ids.map((id) => `<a class="result-link" href="https://example.org/${id}">${id}</a>`).join("\n"));
const hnPage = (...ids: string[]) =>
	Response.json({ hits: ids.map((id) => ({ objectID: id, title: id, url: `https://example.org/${id}` })) });

describe("web search deadlines", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});
	it("keeps waiting past 6s after an early failure and returns the 7s hit", async () => {
		const { ddg, hn } = engines();
		const result = search("q", 5);
		await vi.advanceTimersByTimeAsync(100);
		ddg.reject(new Error("unavailable"));
		await vi.advanceTimersByTimeAsync(6900);
		hn.resolve(hnPage("late"));
		expect((await result).hits[0].title).toBe("late");
		expect(vi.getTimerCount()).toBe(0);
	});
	it("returns early hits at the soft limit and aborts the straggler", async () => {
		const { ddg, signals } = engines();
		const result = search("q", 5);
		ddg.resolve(ddgPage("first"));
		await vi.advanceTimersByTimeAsync(5999);
		expect(signals[1].aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect((await result).hits[0].title).toBe("first");
		expect(signals[1].aborted).toBe(true);
	});
	it("bounds two nonresponsive engines at 12s from launch", async () => {
		const { signals } = engines();
		const result = search("q", 5);
		await vi.advanceTimersByTimeAsync(11999);
		expect(signals[0].aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect((await result).text).toMatch(/No results/);
		expect(signals.every((s) => s.aborted)).toBe(true);
	});
	it("propagates a caller abort even when fetch ignores its signal", async () => {
		const { signals } = engines();
		const controller = new AbortController();
		const result = webSearchTool().execute("call", { query: "q" }, controller.signal, undefined, {} as never);
		controller.abort(new Error("caller cancelled"));
		await expect(result).rejects.toThrow("caller cancelled");
		expect(signals).toHaveLength(2);
		expect(signals.every((s) => s.aborted)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("counts one vote per engine and breaks ties by declared engine order", async () => {
		const { ddg, hn } = engines();
		const result = search("q", 6);
		hn.resolve(hnPage("fast", "common"));
		await vi.advanceTimersByTimeAsync(10);
		ddg.resolve(ddgPage("repeat", "repeat", "repeat", "common"));
		expect((await result).hits.map((hit) => hit.title)).toEqual(["common", "repeat", "fast"]);
	});
});
