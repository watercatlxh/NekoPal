/**
 * Headless stand-ins for the terminal-UI types the extension API still mentions.
 *
 * NekoPal ships no TUI, so these types describe the shape of the arguments an
 * extension receives without pulling in pi-tui. TUI-only members are never
 * called in the daemon; their parameters stay typed as `unknown`.
 */

/** A renderable element in a terminal UI. */
export interface Component {
	render(width: number): string[];
	invalidate?(): void;
}

/** Autocomplete candidate, shaped like pi-tui's. */
export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export type KeyId = string;
export type TUI = unknown;
export type EditorComponent = unknown;
export type EditorTheme = unknown;
export type OverlayHandle = unknown;
export type OverlayOptions = unknown;
export type AutocompleteProvider = unknown;
export interface ProgramStatus {
	kind?: string;
	message?: string;
}
export type Keybinding = unknown;
export type KeybindingsManager = unknown;
/** Name of an application keybinding. */
export type AppKeybinding = string;

/** Theme surface extensions use for tool and message renderers. */
export interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	italic(text: string): string;
	underline(text: string): string;
	inverse(text: string): string;
	strikethrough(text: string): string;
}

/** A theme that adds no escape sequences: every method returns its text unchanged. */
export const plainTheme: Theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	inverse: (text) => text,
	strikethrough: (text) => text,
};
