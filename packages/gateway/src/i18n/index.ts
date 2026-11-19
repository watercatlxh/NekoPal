import type { Lang } from "../channel/types.ts";
import { messages as en } from "./en.ts";
import { messages as zh } from "./zh.ts";

export type { Lang };
export type MessageKey = keyof typeof en;

const tables: Record<Lang, Record<MessageKey, string>> = { en, zh };

/** Translate `key`, interpolating `{{name}}` placeholders from `vars`. */
export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
	const template = tables[lang][key];
	if (!vars) return template;
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** Pick a language from a platform language code, such as Telegram's `zh-hans`. */
export function languageFromCode(code: string | undefined): Lang | undefined {
	if (!code) return undefined;
	return code.toLowerCase().startsWith("zh") ? "zh" : "en";
}
