import { describe, expect, it } from "vitest";
import { describe as describeCommand, formatUptime, parseCommand } from "../src/commands/index.ts";
import { commandMenu, createCommands } from "../src/commands/table.ts";

describe("command table", () => {
	it("parses a command with and without arguments", () => {
		expect(parseCommand("/help")).toEqual({ name: "help", args: "" });
		expect(parseCommand("/model anthropic/claude-haiku-4-5")).toEqual({
			name: "model",
			args: "anthropic/claude-haiku-4-5",
		});
		expect(parseCommand("hello /help")).toBeUndefined();
		// Only lowercase names are commands; anything else, including /Help, is agent input.
		expect(parseCommand("/Help")).toBeUndefined();
		expect(parseCommand("/unknown-command")).toEqual({ name: "unknown-command", args: "" });
	});

	it("describes every command in both languages", () => {
		const commands = createCommands();
		for (const name of commands.keys()) {
			expect(describeCommand(name, "en")).toContain(`/${name} — `);
			expect(describeCommand(name, "zh")).toContain(`/${name} — `);
			expect(describeCommand(name, "en")).not.toBe(describeCommand(name, "zh"));
		}
	});

	it("omits /cancel from the platform menu", () => {
		const menu = commandMenu("en");
		expect(menu.map((entry) => entry.command)).not.toContain("cancel");
		expect(menu).toHaveLength(createCommands().size - 1);
		expect(menu.every((entry) => entry.description.length > 0)).toBe(true);
	});

	it("formats uptime compactly", () => {
		expect(formatUptime(5_000)).toBe("5s");
		expect(formatUptime(65_000)).toBe("1m5s");
		expect(formatUptime(3_725_000)).toBe("1h2m");
	});
});
