import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

/**
 * The daemon reaches the Bot APIs over fetch, which ignores HTTP_PROXY on its own. These assertions
 * pin the two pieces main() wires together, so a refactor cannot silently drop the proxy again.
 */
describe("proxy settings", () => {
	it("reads httpProxy and the idle timeout from settings.toml", () => {
		const root = mkdtempSync(join(tmpdir(), "nekopal-proxy-"));
		const manager = SettingsManager.create(root, root);
		manager.applyOverrides({ httpProxy: "http://127.0.0.1:7890", httpIdleTimeoutMs: 120_000 });

		const settings = manager.getSettings();
		expect(settings.httpProxy).toBe("http://127.0.0.1:7890");
		expect(settings.httpIdleTimeoutMs).toBe(120_000);
	});

	it("leaves both unset when the file does not mention them", () => {
		const root = mkdtempSync(join(tmpdir(), "nekopal-proxy-"));
		const settings = SettingsManager.create(root, root).getSettings();
		expect(settings.httpProxy).toBeUndefined();
		expect(settings.httpIdleTimeoutMs).toBeUndefined();
	});
});
