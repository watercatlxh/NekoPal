/**
 * The custom-provider wizard: a four-question state machine.
 *
 * Pure: it validates answers and advances, and never touches the network or the chat. The caller
 * probes the model list between `apiKey` and `confirm`, and writes `models.json` after `save`.
 */

import type { Lang } from "../channel/types.ts";
import { t } from "../i18n/index.ts";
import { API_KINDS, type ApiKind, type CustomModel, modelFromId } from "./models-json.ts";

/** Where the wizard is. */
export type ProviderStep = "id" | "baseUrl" | "api" | "apiKey" | "confirm";

/** What has been answered so far. */
export interface ProviderDraft {
	readonly step: ProviderStep;
	readonly id: string;
	readonly baseUrl: string;
	readonly api: ApiKind | undefined;
	readonly apiKey: string;
	/** Model ids the probe found; empty when it failed or has not run. */
	readonly models: readonly string[];
	/** Why the probe found nothing, shown on the confirm page. */
	readonly probeError?: string;
}

/** A provider id: lowercase, may contain `-` and `_`, at most 32 characters. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** What an answer produced: the next draft, or a message to show while staying on the step. */
export type Answer = { readonly draft: ProviderDraft } | { readonly error: string };

/** A fresh draft at the first question. */
export function newDraft(): ProviderDraft {
	return { step: "id", id: "", baseUrl: "", api: undefined, apiKey: "", models: [] };
}

/** Whether `text` is a usable provider id. */
export function validId(text: string): boolean {
	return ID_PATTERN.test(text);
}

/** Whether `text` is a usable base URL. */
export function validBaseUrl(text: string): boolean {
	return /^https?:\/\/[^\s]+$/.test(text);
}

/**
 * Apply a typed answer.
 *
 * `taken` reports whether a provider id is already in use, so a duplicate is rejected here rather
 * than overwriting a working provider.
 */
export function applyText(draft: ProviderDraft, text: string, taken: (id: string) => boolean): Answer {
	const answer = text.trim();
	if (answer === "") return { error: "empty" };
	switch (draft.step) {
		case "id": {
			if (!validId(answer)) return { error: "id" };
			if (taken(answer)) return { error: "taken" };
			return { draft: { ...draft, step: "baseUrl", id: answer } };
		}
		case "baseUrl": {
			if (!validBaseUrl(answer)) return { error: "baseUrl" };
			return { draft: { ...draft, step: "api", baseUrl: answer.replace(/\/+$/, "") } };
		}
		case "api": {
			// This step is answered with a button; a typed answer names the same values.
			if (!(API_KINDS as readonly string[]).includes(answer)) return { error: "api" };
			return { draft: { ...draft, step: "apiKey", api: answer as ApiKind } };
		}
		case "apiKey": {
			return { draft: { ...draft, step: "confirm", apiKey: answer } };
		}
		case "confirm":
			// The confirm step is answered with a button.
			return { error: "confirm" };
	}
}

/** Apply a button press: the API kind, or save/cancel on the confirm page. */
export function applyChoice(draft: ProviderDraft, verb: string, arg: string): ProviderDraft | undefined {
	if (verb === "api" && draft.step === "api") {
		if (!(API_KINDS as readonly string[]).includes(arg)) return undefined;
		return { ...draft, step: "apiKey", api: arg as ApiKind };
	}
	return undefined;
}

/** Record what the model probe found. */
export function withProbe(draft: ProviderDraft, models: readonly string[], error?: string): ProviderDraft {
	return { ...draft, models, ...(error === undefined ? {} : { probeError: error }) };
}

/** The provider to write once the user confirms. */
export function toProvider(draft: ProviderDraft): {
	name: string;
	baseUrl: string;
	api: ApiKind;
	apiKey: string;
	models: readonly CustomModel[];
} {
	if (draft.api === undefined) throw new Error("panel: the wizard has no api kind");
	return {
		name: draft.id,
		baseUrl: draft.baseUrl,
		api: draft.api,
		apiKey: draft.apiKey,
		models: draft.models.map(modelFromId),
	};
}

/** The question for the current step, in the chat's language. */
export function question(draft: ProviderDraft, lang: Lang): string {
	switch (draft.step) {
		case "id":
			return t(lang, "wizard.id");
		case "baseUrl":
			return t(lang, "wizard.baseUrl");
		case "api":
			return t(lang, "wizard.api");
		case "apiKey":
			return t(lang, "wizard.apiKey");
		case "confirm":
			return t(lang, "wizard.confirm");
	}
}
