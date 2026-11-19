import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";

/**
 * Extensions every NekoPal session loads: codemode, tool search and MCP, the three the pi CLI
 * bundled. The CLI's llama.cpp extension is not shipped.
 *
 * They are replaceable: an installed extension that registers the same tools, commands or flags
 * takes their place instead of conflicting with them.
 */
export const builtInExtensions: InlineExtension[] = [
	{ name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
	{ name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
	{ name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
];
