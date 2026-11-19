import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { STATE_PATH } from "./paths.ts";
import { logError } from "./log.ts";
import type { Lang } from "./channel/types.ts";

export interface ChatState {
	lang?: Lang;
}

export interface State {
	chats: Record<string, ChatState>;
	telegram: { offset: number };
	qq: { day: string; sentToday: Record<string, number> };
}

function emptyState(): State {
	return { chats: {}, telegram: { offset: 0 }, qq: { day: "", sentToday: {} } };
}

/** Runtime state persisted across restarts: chat languages, the Telegram offset and QQ quotas. */
export class StateStore {
	private state: State;
	private timer: NodeJS.Timeout | undefined;

	private constructor(state: State) {
		this.state = state;
	}

	static load(): StateStore {
		if (!existsSync(STATE_PATH)) return new StateStore(emptyState());
		try {
			const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<State>;
			return new StateStore({
				chats: parsed.chats ?? {},
				telegram: { offset: parsed.telegram?.offset ?? 0 },
				qq: { day: parsed.qq?.day ?? "", sentToday: parsed.qq?.sentToday ?? {} },
			});
		} catch (error) {
			const backup = `${STATE_PATH}.corrupt-${Date.now()}`;
			try {
				renameSync(STATE_PATH, backup);
			} catch {
				// Nothing else to do: the corrupt file stays where it is.
			}
			logError(`could not read state.json, starting fresh (backup: ${backup})`, error);
			return new StateStore(emptyState());
		}
	}

	get chats(): Record<string, ChatState> {
		return this.state.chats;
	}

	get telegramOffset(): number {
		return this.state.telegram.offset;
	}

	set telegramOffset(offset: number) {
		this.state.telegram.offset = offset;
		this.scheduleSave();
	}

	get qq(): { day: string; sentToday: Record<string, number> } {
		return this.state.qq;
	}

	/** Change state and write it back after a short delay. */
	mutate(change: (state: State) => void): void {
		change(this.state);
		this.scheduleSave();
	}

	private scheduleSave(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, 1_000);
		this.timer.unref();
	}

	/** Write the current state now. */
	flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const temp = `${STATE_PATH}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(this.state, null, "\t")}\n`, "utf-8");
			renameSync(temp, STATE_PATH);
		} catch (error) {
			logError("could not write state.json", error);
		}
	}
}
