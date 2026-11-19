import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const FIXTURES = join(import.meta.dirname, "fixtures", "pi-extensions");

/**
 * The pi extensions NekoPal claims to support must load unchanged, and a TUI-dependent one must fail
 * with an actionable message instead of silently doing nothing.
 */
describe("pi extension compatibility", () => {
	async function load(names: string[]) {
		const dir = mkdtempSync(join(tmpdir(), "nekopal-ext-"));
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: names.map((name) => join(FIXTURES, name)),
		});
		await loader.reload();
		return loader.getExtensions();
	}

	it("loads the non-TUI example extensions", async () => {
		const result = await load(["status-line.ts", "dynamic-tools.ts", "confirm-destructive.ts"]);
		expect(result.errors).toEqual([]);
		expect(result.extensions.map((extension) => extension.path.split("/").pop()).sort()).toEqual(
			["confirm-destructive.ts", "dynamic-tools.ts", "status-line.ts"].sort(),
		);
	});

	it("reports a TUI-dependent extension with a message that names pi-tui", async () => {
		const result = await load(["custom-footer.ts"]);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0].error).toMatch(/Extension requires @earendil-works\/pi-tui \(terminal UI\)/);
		expect(result.extensions.map((extension) => extension.path.split("/").pop())).not.toContain("custom-footer.ts");
	});
});
