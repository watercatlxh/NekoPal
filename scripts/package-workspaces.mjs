import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);

/** Every directory under `root` that holds a `package.json`, sorted. */
export function findPackageDirectories(root = "packages") {
	const packageDirectories = [];

	function visit(directory) {
		if (existsSync(join(directory, "package.json"))) {
			packageDirectories.push(directory);
		}

		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			visit(join(directory, entry.name));
		}
	}

	visit(root);
	return packageDirectories.sort();
}

/**
 * The workspace packages: the direct children of `root`, matching `workspaces: ["packages/*"]`.
 *
 * NekoPal publishes nothing, so every package counts, private or not. Fixtures and generated
 * directories below a package are not workspaces and are deliberately excluded.
 */
export function getWorkspacePackages(root = "packages") {
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "package.json")))
		.map((entry) => join(root, entry.name))
		.sort()
		.map((directory) => ({ directory, ...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) }))
		.filter((pkg) => typeof pkg.name === "string" && typeof pkg.version === "string")
		.map(({ directory, name, version }) => ({ directory, name, version }));
}
