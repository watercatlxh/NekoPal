/**
 * `callback_data` for the panel buttons.
 *
 * Telegram caps the payload at 64 bytes, so the encoding is `page:verb:arg` with a short id as the
 * argument. A button also carries the command a channel without callbacks types into the input box,
 * which is why both forms are built from the same description.
 */

import { createHash } from "node:crypto";

/** The panel page a button belongs to; pressing it re-renders that page. */
export type PanelPage = "set" | "mdl" | "think" | "pvd" | "ses" | "pkg" | "mem" | "job" | "sys";

/** Telegram's hard limit for one button payload, in bytes. */
const MAX_DATA_BYTES = 64;

export interface PanelButton {
	readonly label: string;
	/** Callback payload, used by channels with button callbacks. */
	readonly data: string;
	/** Command a channel without callbacks types into the input box. */
	readonly command: string;
}

/** A button that only navigates: no command, just another page. */
export function navButton(label: string, page: PanelPage): PanelButton {
	return actButton(label, `nav:${page}`);
}

/** Build an action from its page, verb and argument. */
export function runButton(label: string, page: PanelPage, verb: string, arg: string): PanelButton {
	return actButton(label, arg === "" ? `${page}:${verb}` : `${page}:${verb}:${arg}`);
}

/** Encode the same action for Telegram callbacks and QQ command buttons. */
export function actButton(label: string, data: string): PanelButton {
	assertFits(data);
	return { label, data, command: `/settings act ${data}` };
}

/** One decoded button press. */
export interface PanelPress {
	readonly page: PanelPage;
	readonly verb: string;
	readonly arg: string;
}

const PAGES: Record<string, PanelPage> = {
	set: "set",
	mdl: "mdl",
	think: "think",
	pvd: "pvd",
	ses: "ses",
	pkg: "pkg",
	mem: "mem",
	job: "job",
	sys: "sys",
};

/** Split `page:verb:arg`; undefined for anything this panel did not encode. */
export function decode(data: string): PanelPress | undefined {
	if (Buffer.byteLength(data) > MAX_DATA_BYTES || /\s/.test(data)) return undefined;
	const [rawPage, verb = "", ...rest] = data.split(":");
	// A navigation press carries the target page in the verb slot.
	if (rawPage === "nav") {
		return rest.length === 0 && Object.hasOwn(PAGES, verb) ? { page: PAGES[verb], verb: "nav", arg: "" } : undefined;
	}
	if (rawPage === "pg") {
		return rest.length === 1 && Object.hasOwn(PAGES, verb)
			? { page: PAGES[verb], verb: "pg", arg: rest[0] }
			: undefined;
	}
	if (!Object.hasOwn(PAGES, rawPage) || !/^[a-z]+$/.test(verb) || verb === "nav") return undefined;
	return { page: PAGES[rawPage], verb, arg: rest.join(":") };
}

/** Stable callback key for the complete, untruncated identity of an entry. */
export function panelKey(parts: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 16);
}

/** Resolve against the current list; missing and ambiguous selections are both stale. */
export function resolvePanelKey<T>(
	key: string,
	items: Iterable<T>,
	parts: (item: T) => readonly string[],
): T | undefined {
	if (!/^[\w-]{16}$/.test(key)) return undefined;
	let match: T | undefined;
	for (const item of items) {
		if (panelKey(parts(item)) !== key) continue;
		if (match !== undefined) return undefined;
		match = item;
	}
	return match;
}

export function pendingKey(ids: readonly string[]): string {
	return panelKey([...new Set(ids)].sort());
}

/** Throw at build time rather than at send time when a payload outgrew the platform limit. */
function assertFits(data: string): void {
	const bytes = Buffer.byteLength(data, "utf-8");
	if (bytes > MAX_DATA_BYTES) throw new Error(`panel: callback_data ${bytes} bytes exceeds ${MAX_DATA_BYTES}`);
}

/** The button rows for a page, wrapped into the `Keyboard` the adapters take. */
export function toKeyboard(rows: ReadonlyArray<ReadonlyArray<PanelButton>>) {
	return rows.map((row) => row.map((button) => ({ label: button.label, data: button.data, command: button.command })));
}
