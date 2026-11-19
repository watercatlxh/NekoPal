import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatStored, storedEntries } from "../src/commands/memory.ts";
import { SkillStore } from "../src/memory/skills.ts";
import { MemoryStore } from "../src/memory/store.ts";

function store(): MemoryStore {
	const dir = mkdtempSync(join(tmpdir(), "nekopal-cmd-memory-"));
	return new MemoryStore({
		memoryPath: join(dir, "MEMORY.md"),
		userPath: join(dir, "USER.md"),
		budgets: { memoryChars: 2_200, userChars: 1_375 },
	});
}

describe("/memory list numbering", () => {
	it("numbers both stores in one sequence and maps back to the store index", () => {
		const memory = store();
		memory.apply("memory", [{ action: "add", content: "env fact" }]);
		memory.apply("user", [
			{ action: "add", content: "likes tea" },
			{ action: "add", content: "prefers short answers" },
		]);

		const entries = storedEntries(memory);
		expect(entries.map((entry) => [entry.number, entry.target, entry.index])).toEqual([
			[1, "memory", 1],
			[2, "user", 1],
			[3, "user", 2],
		]);

		// Entry #3 is the user store's second entry, which is what forget takes.
		const third = entries.find((entry) => entry.number === 3)!;
		expect(memory.forget(third.target, third.index)).toBe("prefers short answers");
		expect(memory.entries("user")).toEqual(["likes tea"]);
	});

	it("prints the numbers the list shows", () => {
		const memory = store();
		memory.apply("memory", [{ action: "add", content: "env fact" }]);
		expect(formatStored(memory)).toBe("1. [memory] env fact");
	});
});

describe("SkillStore", () => {
	it("writes, patches and removes a skill", () => {
		const dir = mkdtempSync(join(tmpdir(), "nekopal-skills-"));
		const skills = new SkillStore(dir);
		skills.apply([
			{
				action: "add",
				name: "deploy-check",
				content: "---\nname: deploy-check\ndescription: how to verify a deploy\n---\n\nrun it\n",
			},
		]);
		expect(skills.names()).toEqual(["deploy-check"]);
		expect(skills.read("deploy-check")).toContain("run it");

		skills.apply([{ action: "patch", name: "deploy-check", old_text: "run it", content: "check the logs" }]);
		expect(skills.read("deploy-check")).toContain("check the logs");

		skills.apply([{ action: "remove", name: "deploy-check" }]);
		expect(skills.names()).toEqual([]);
	});

	it("rejects a name that could escape the skills directory", () => {
		const skills = new SkillStore(mkdtempSync(join(tmpdir(), "nekopal-skills-")));
		expect(() => skills.apply([{ action: "add", name: "../evil", content: "x" }])).toThrow(/Invalid skill name/);
	});
});
