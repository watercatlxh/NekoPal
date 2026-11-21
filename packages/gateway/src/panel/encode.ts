/**
 * `callback_data` for the panel buttons.
 *
 * Telegram caps the payload at 64 bytes, so the encoding is `page:verb:arg` with a short id as the
 * argument. A button also carries the command a channel without callbacks types into the input box,
 * which is why both forms are built from the same description.
 */

/** The panel page a button belongs to; pressing it re-renders that page. */
export type PanelPage = "set" | "mdl" | "pvd" | "ses" | "pkg" | "mem" | "job";

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
	return { label, data: `nav:${page}`, command: `/settings ${page === "set" ? "" : page}`.trim() };
}

/** A button that runs `command` and then shows `page` again. */
export function runButton(label: string, page: PanelPage, verb: string, arg: string, command: string): PanelButton {
	const data = arg === "" ? `${page}:${verb}` : `${page}:${verb}:${arg}`;
	assertFits(data);
	return { label, data, command };
}

/** A button that only carries a callback, with no equivalent typed command (a wizard step). */
export function actButton(label: string, data: string): PanelButton {
	assertFits(data);
	return { label, data, command: "/settings" };
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
	pvd: "pvd",
	ses: "ses",
	pkg: "pkg",
	mem: "mem",
	job: "job",
};

/** Split `page:verb:arg`; undefined for anything this panel did not encode. */
export function decode(data: string): PanelPress | undefined {
	const [rawPage, verb = "", ...rest] = data.split(":");
	// A navigation press carries the target page in the verb slot.
	if (rawPage === "nav") {
		const target = PAGES[verb];
		return target === undefined ? undefined : { page: target, verb: "nav", arg: "" };
	}
	const page = PAGES[rawPage];
	if (page === undefined) return undefined;
	return { page, verb, arg: rest.join(":") };
}

/** Throw at build time rather than at send time when a payload outgrew the platform limit. */
function assertFits(data: string): void {
	const bytes = Buffer.byteLength(data, "utf-8");
	if (bytes > MAX_DATA_BYTES)
		throw new Error(`panel: callback_data ${bytes} bytes exceeds ${MAX_DATA_BYTES}: ${data}`);
}

/** The button rows for a page, wrapped into the `Keyboard` the adapters take. */
export function toKeyboard(rows: ReadonlyArray<ReadonlyArray<PanelButton>>) {
	return rows.map((row) => row.map((button) => ({ label: button.label, data: button.data, command: button.command })));
}
