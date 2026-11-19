import { describe, expect, test, vi } from "vitest";
import { type QqApi, QqError } from "../src/channel/qq/api.ts";
import { QqStream } from "../src/channel/qq/stream.ts";

interface Call {
	path: string;
	body: Record<string, unknown>;
}

function fakeApi(fail?: (body: Record<string, unknown>) => Error | undefined) {
	const calls: Call[] = [];
	const api = {
		async call(_method: string, path: string, body: unknown): Promise<{ id?: string; stream_msg_id?: string }> {
			const parsed = (body ?? {}) as Record<string, unknown>;
			const failure = fail?.(parsed);
			if (failure) throw failure;
			calls.push({ path, body: parsed });
			return { id: "m1", stream_msg_id: "s1" };
		},
	} as unknown as QqApi;
	return { api, calls };
}

describe("QqStream", () => {
	test("replaces the visible text and finishes with input_state 10", async () => {
		const { api, calls } = fakeApi();
		const stream = QqStream.open({
			api,
			chatId: "u1",
			budget: { take: () => ({ msgId: "in-1", msgSeq: 1 }) },
			logError: () => {},
		});
		expect(stream).toBeDefined();

		await stream!.update("first");
		await stream!.update("first");
		await stream!.update("second");
		const handle = await stream!.finish("second");

		expect(handle).toEqual({ id: "m1" });
		expect(calls.map((call) => call.body.input_state)).toEqual([1, 1, 10]);
		expect(calls[0].body).toMatchObject({
			input_mode: "replace",
			content_type: "markdown",
			content_raw: "first",
			index: 0,
			msg_id: "in-1",
			msg_seq: 1,
		});
		// The stream id from the first response rides on every later frame.
		expect(calls[1].body.stream_msg_id).toBe("s1");
		expect(calls[2].body.content_raw).toBe("second");
	});

	test("degrades after a rejection so the caller sends the reply as a message", async () => {
		const logError = vi.fn();
		const { api } = fakeApi((body) =>
			body.input_state === 1 ? new QqError(400, "prefix cannot change", 40007) : undefined,
		);
		const stream = QqStream.open({
			api,
			chatId: "u1",
			budget: { take: () => ({}) },
			logError,
		})!;

		await stream.update("hello");
		expect(stream.isDegraded).toBe(true);
		expect(await stream.finish("hello")).toBeUndefined();
		expect(logError).toHaveBeenCalledOnce();
	});

	test("does not open when the reply budget is spent", () => {
		const { api } = fakeApi();
		expect(
			QqStream.open({ api, chatId: "u1", budget: { take: () => undefined }, logError: () => {} }),
		).toBeUndefined();
	});
});
