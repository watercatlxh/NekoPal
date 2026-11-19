import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Adapter } from "../channel/types.ts";

const parameters = Type.Object({
	text: Type.Optional(Type.String({ description: "Message text, in Markdown" })),
	files: Type.Optional(Type.Array(Type.String(), { description: "File paths, relative to the working directory" })),
});

export interface SendToolOptions {
	adapter: Adapter;
	chatId: string;
	cwd: string;
}

/** The `send` tool: deliver a message or files to the current chat, beyond the reply itself. */
export function sendTool(options: SendToolOptions): ToolDefinition<typeof parameters> {
	return defineTool({
		name: "send",
		label: "send",
		description:
			"Send a message or files to the user in this chat. Use it for long output saved to a file, or to deliver something before the final reply.",
		promptSnippet: "send: deliver a message or files to the user",
		parameters,
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			if (!params.text && !params.files?.length) throw new Error("Provide text or files");
			if (params.text) await options.adapter.sendMarkdown(options.chatId, params.text);
			if (params.files?.length) {
				const paths = params.files.map((file) => {
					const path = isAbsolute(file) ? file : resolve(options.cwd, file);
					if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`No such file: ${path}`);
					return path;
				});
				await options.adapter.sendFiles(options.chatId, paths);
			}
			return { content: [{ type: "text", text: "Sent." }], details: undefined };
		},
	});
}
