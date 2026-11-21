/**
 * QQ C2C message buttons.
 *
 * QQ has no callback channel for a C2C bot message here and cannot edit a sent message, so every
 * button is a command button: pressing it types `/…` into the input box and, with `enter`, sends it.
 * The layout caps at 5 rows of 5, which is the platform's hard limit.
 */

import type { Keyboard } from "../types.ts";

/** Rows and columns QQ accepts. */
const MAX_ROWS = 5;
const MAX_COLUMNS = 5;
/** `render_data.style`: 1 is the blue outline, the only style that renders reliably on every client. */
const STYLE_PRIMARY = 1;

/** One QQ button, in the shape the message payload takes. */
interface QqButton {
	id: string;
	render_data: { label: string; visited_label: string; style: number };
	action: {
		type: number;
		permission: { type: number };
		data: string;
		enter: boolean;
		unsupport_tips: string;
	};
}

/** A keyboard payload, or undefined when there is nothing to send. */
export function keyboardToMarkup(
	keyboard: Keyboard | undefined,
): { content: { rows: Array<{ buttons: QqButton[] }> } } | undefined {
	if (!keyboard || keyboard.length === 0) return undefined;
	const rows: Array<{ buttons: QqButton[] }> = [];
	let index = 0;
	for (const row of keyboard.slice(0, MAX_ROWS)) {
		const buttons = row.slice(0, MAX_COLUMNS).map((button) => {
			const id = String(index);
			index += 1;
			return {
				id,
				render_data: { label: button.label, visited_label: button.label, style: STYLE_PRIMARY },
				action: {
					// Type 2 types the command into the input box; `enter` sends it without a tap.
					type: 2,
					permission: { type: 2 },
					data: button.command,
					enter: true,
					unsupport_tips: button.label,
				},
			};
		});
		if (buttons.length > 0) rows.push({ buttons });
	}
	return rows.length === 0 ? undefined : { content: { rows } };
}
