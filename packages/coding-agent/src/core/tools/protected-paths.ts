import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface ProtectedPath {
	/** Absolute path or directory that tools must not write. */
	path: string;
	/** Error message a tool reports when the path is written. */
	message: string;
}

let protectedPaths: ProtectedPath[] = [];

/** Register paths that the write and edit tools refuse to modify. Replaces any previous set. */
export function setProtectedPaths(entries: ProtectedPath[]): void {
	protectedPaths = entries.map((entry) => ({ path: resolve(entry.path), message: entry.message }));
}

function normalize(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		// The file does not exist yet: compare the resolved path, resolving the directory that does.
		return absolute;
	}
}

/** The message of the protected path that covers `absolutePath`, or undefined when it is writable. */
export function checkProtectedPath(absolutePath: string): string | undefined {
	if (protectedPaths.length === 0) return undefined;
	const candidate = normalize(absolutePath);
	for (const entry of protectedPaths) {
		if (normalize(entry.path) === candidate) return entry.message;
	}
	return undefined;
}
