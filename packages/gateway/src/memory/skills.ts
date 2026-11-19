import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILLS_DIR } from "../paths.ts";
import type { MemoryOperation } from "./store.ts";

/** Applies approved skill operations under `~/.nekopal/skills/<name>/SKILL.md`. */
export class SkillStore {
	private readonly dir: string;

	constructor(dir: string = SKILLS_DIR) {
		this.dir = dir;
	}

	names(): string[] {
		mkdirSync(this.dir, { recursive: true });
		return readdirSync(this.dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	}

	read(name: string): string | undefined {
		try {
			return readFileSync(join(this.dir, name, "SKILL.md"), "utf-8");
		} catch {
			return undefined;
		}
	}

	apply(operations: MemoryOperation[]): void {
		mkdirSync(this.dir, { recursive: true });
		for (const operation of operations) {
			const name = operation.name;
			if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
				throw new Error(`Invalid skill name: ${name ?? "(missing)"}`);
			}
			const file = join(this.dir, name, "SKILL.md");
			if (operation.action === "remove") {
				rmSync(join(this.dir, name), { recursive: true, force: true });
				continue;
			}
			if (operation.action === "add") {
				if (!operation.content) throw new Error("add needs content");
				mkdirSync(join(this.dir, name), { recursive: true });
				writeFileSync(file, operation.content, "utf-8");
				continue;
			}
			const current = readFileSync(file, "utf-8");
			if (!operation.old_text) throw new Error("patch needs old_text");
			if (!current.includes(operation.old_text)) throw new Error(`Skill ${name} has no such text`);
			writeFileSync(file, current.replace(operation.old_text, operation.content ?? ""), "utf-8");
		}
	}
}
