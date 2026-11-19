import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.NEKOPAL_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.NEKOPAL_EXPERIMENTAL;
		} else {
			process.env.NEKOPAL_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when NEKOPAL_EXPERIMENTAL is unset", () => {
		delete process.env.NEKOPAL_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when NEKOPAL_EXPERIMENTAL is empty", () => {
		process.env.NEKOPAL_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when NEKOPAL_EXPERIMENTAL is set to 1", () => {
		process.env.NEKOPAL_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when NEKOPAL_EXPERIMENTAL is set to 0", () => {
		process.env.NEKOPAL_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when NEKOPAL_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.NEKOPAL_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
