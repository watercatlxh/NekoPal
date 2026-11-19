export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.NEKOPAL_EXPERIMENTAL === "1";
}
