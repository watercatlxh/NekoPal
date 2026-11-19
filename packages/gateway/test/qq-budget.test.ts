import { describe, expect, test } from "vitest";
import { localDateKey, PassiveBudget, ProactiveBudget, type ProactiveCounts } from "../src/channel/qq/budget.ts";

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 10, 19, 9, 0, 0);

describe("PassiveBudget", () => {
	test("hands out msg_seq values 1 through 4 and then refuses", () => {
		const budget = new PassiveBudget();
		budget.register("msg-1", BASE);

		expect(budget.takePassive("msg-1", BASE)).toBe(1);
		expect(budget.takePassive("msg-1", BASE)).toBe(2);
		expect(budget.takePassive("msg-1", BASE)).toBe(3);
		expect(budget.takePassive("msg-1", BASE)).toBe(4);
		expect(budget.takePassive("msg-1", BASE)).toBeUndefined();
	});

	test("closes the window 61 minutes after the message arrived", () => {
		const budget = new PassiveBudget();
		budget.register("msg-1", BASE);

		expect(budget.takePassive("msg-1", BASE + 61 * MINUTE)).toBeUndefined();
	});

	test("keeps the window open just under the hour", () => {
		const budget = new PassiveBudget();
		budget.register("msg-1", BASE);

		expect(budget.takePassive("msg-1", BASE + 59 * MINUTE)).toBe(1);
	});

	test("budgets each inbound message separately", () => {
		const budget = new PassiveBudget();
		budget.register("msg-1", BASE);
		budget.register("msg-2", BASE);

		expect(budget.takePassive("msg-1", BASE)).toBe(1);
		expect(budget.takePassive("msg-1", BASE)).toBe(2);
		expect(budget.takePassive("msg-2", BASE)).toBe(1);
	});

	test("reports the remaining slots", () => {
		const budget = new PassiveBudget();
		budget.register("msg-1", BASE);

		expect(budget.remaining("msg-1", BASE)).toBe(4);
		budget.takePassive("msg-1", BASE);
		expect(budget.remaining("msg-1", BASE)).toBe(3);
		expect(budget.remaining("unknown", BASE)).toBe(0);
	});
});

describe("ProactiveBudget", () => {
	test("refuses the 19th send inside one minute when perMinute is 18", () => {
		const budget = new ProactiveBudget({ perMinute: 18, perDay: 1000 });
		const openid = "openid-1";

		for (let index = 0; index < 18; index += 1) {
			expect(budget.takeProactive(openid, BASE + index * 1_000)).toBe(true);
		}
		expect(budget.takeProactive(openid, BASE + 18_000)).toBe(false);
		expect(budget.remaining(openid, BASE + 18_000)).toBe(0);
	});

	test("allows a send again once the minute window slides", () => {
		const budget = new ProactiveBudget({ perMinute: 2, perDay: 1000 });
		const openid = "openid-1";

		expect(budget.takeProactive(openid, BASE)).toBe(true);
		expect(budget.takeProactive(openid, BASE + 30_000)).toBe(true);
		expect(budget.takeProactive(openid, BASE + 40_000)).toBe(false);
		expect(budget.takeProactive(openid, BASE + 61_000)).toBe(true);
	});

	test("counts each openid separately", () => {
		const budget = new ProactiveBudget({ perMinute: 1, perDay: 1000 });

		expect(budget.takeProactive("a", BASE)).toBe(true);
		expect(budget.takeProactive("a", BASE)).toBe(false);
		expect(budget.takeProactive("b", BASE)).toBe(true);
	});

	test("resets the day counter when the local date changes", () => {
		let counts: ProactiveCounts = { day: "2026-11-19", sentToday: { "openid-1": 5 } };
		const budget = new ProactiveBudget({
			perMinute: 18,
			perDay: 5,
			storage: {
				load: () => counts,
				save: (next) => {
					counts = next;
				},
			},
		});
		const openid = "openid-1";

		expect(budget.takeProactive(openid, BASE)).toBe(false);

		const tomorrow = BASE + 24 * 60 * MINUTE;
		expect(budget.takeProactive(openid, tomorrow)).toBe(true);
		expect(counts.day).toBe(localDateKey(tomorrow));
		expect(counts.sentToday[openid]).toBe(1);
	});

	test("persists the daily counters through the storage callbacks", () => {
		let counts: ProactiveCounts = { day: "", sentToday: {} };
		const storage = {
			load: () => counts,
			save: (next: ProactiveCounts) => {
				counts = next;
			},
		};
		const first = new ProactiveBudget({ perMinute: 18, perDay: 2, storage });
		expect(first.takeProactive("openid-1", BASE)).toBe(true);
		expect(first.takeProactive("openid-1", BASE)).toBe(true);

		const restarted = new ProactiveBudget({ perMinute: 18, perDay: 2, storage });
		expect(restarted.takeProactive("openid-1", BASE)).toBe(false);
	});
});

describe("localDateKey", () => {
	test("formats the local calendar date", () => {
		const local = new Date(2026, 10, 9, 23, 30, 0);
		expect(localDateKey(local.getTime())).toBe("2026-11-09");
	});
});
