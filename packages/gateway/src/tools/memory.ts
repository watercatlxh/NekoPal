import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { SKILLS_DIR } from "../paths.ts";
import type { MemoryOperation, MemoryStore, PendingStore } from "../memory/store.ts";
import { firstThreat } from "../memory/threats.ts";

const SKILL_NAME = /^[a-z0-9-]{1,64}$/;

const parameters = Type.Object({
	target: Type.Union([Type.Literal("memory"), Type.Literal("user"), Type.Literal("skill")], {
		description: "memory: facts about the environment; user: who the user is; skill: a reusable procedure",
	}),
	operations: Type.Array(
		Type.Object({
			action: Type.Union([Type.Literal("add"), Type.Literal("patch"), Type.Literal("remove")]),
			content: Type.Optional(Type.String({ description: "Entry text, or the whole SKILL.md for a new skill" })),
			old_text: Type.Optional(Type.String({ description: "Text identifying the single entry to patch or remove" })),
			name: Type.Optional(Type.String({ description: "Skill directory name, for target skill" })),
		}),
		{ minItems: 1 },
	),
});

export interface MemoryToolOptions {
	store: MemoryStore;
	pending: PendingStore;
	skillsDir?: string;
	/** `chat` writes immediately; `review` stages the operations for approval. */
	origin: "chat" | "review";
}

function summaryOf(operations: MemoryOperation[]): string {
	const first = operations[0];
	const text = first.content ?? first.old_text ?? "";
	return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function skillPath(name: string, skillsDir: string): string {
	if (!SKILL_NAME.test(name)) throw new Error("Skill name must match ^[a-z0-9-]{1,64}$");
	return join(skillsDir, name, "SKILL.md");
}

function writeSkill(name: string, content: string, skillsDir: string): void {
	const path = skillPath(name, skillsDir);
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!frontmatter) throw new Error("SKILL.md needs a frontmatter block with name and description");
	for (const field of ["name", "description"]) {
		if (!new RegExp(`^${field}\\s*:`, "m").test(frontmatter[1])) {
			throw new Error(`SKILL.md frontmatter is missing ${field}`);
		}
	}
	mkdirSync(join(skillsDir, name), { recursive: true });
	writeFileSync(path, content, "utf-8");
}

function patchSkill(name: string, oldText: string, content: string, skillsDir: string): void {
	const path = skillPath(name, skillsDir);
	if (!existsSync(path)) throw new Error(`No skill named ${name}`);
	const current = readFileSync(path, "utf-8");
	const matches = current.split(oldText).length - 1;
	if (matches !== 1) throw new Error(`old_text matches ${matches} places in ${name}; it must match exactly one`);
	writeFileSync(path, current.replace(oldText, content), "utf-8");
}

/** The `memory` tool: save durable facts about the user, the environment, or reusable procedures. */
export function memoryTool(options: MemoryToolOptions): ToolDefinition<typeof parameters> {
	const skillsDir = options.skillsDir ?? SKILLS_DIR;
	return defineTool({
		name: "memory",
		label: "memory",
		description:
			"Save durable facts across sessions. target user: preferences and personal details; target memory: environment facts, paths, services; target skill: a reusable procedure.",
		promptSnippet:
			"memory: save durable facts about the user (target user), the environment (target memory), or reusable procedures (target skill)",
		parameters,
		async execute(_toolCallId, params): Promise<AgentToolResult<unknown>> {
			const operations = params.operations as MemoryOperation[];
			for (const operation of operations) {
				const text = operation.content ?? "";
				if (text && firstThreat(text)) throw new Error("content looks like a prompt injection; refusing to store it");
			}

			if (options.origin === "review") {
				const pending = options.pending.add({
					target: params.target,
					operations,
					summary: summaryOf(operations),
				});
				return { content: [{ type: "text", text: `Staged as ${pending.id}.` }], details: undefined };
			}

			if (params.target === "skill") {
				for (const operation of operations) {
					const name = operation.name ?? "";
					if (operation.action === "add") writeSkill(name, operation.content ?? "", skillsDir);
					else if (operation.action === "patch") {
						patchSkill(name, operation.old_text ?? "", operation.content ?? "", skillsDir);
					} else rmSync(join(skillsDir, name), { recursive: true, force: true });
				}
				return { content: [{ type: "text", text: "Saved." }], details: undefined };
			}

			options.store.apply(params.target, operations);
			return { content: [{ type: "text", text: "Saved." }], details: undefined };
		},
	});
}
