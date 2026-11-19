import type { ClientIdentity } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";

/**
 * How NekoPal's requests identify it to providers: a detailed `User-Agent` with the app version.
 */
export function getClientIdentity(): ClientIdentity {
	return { userAgent: "detailed", version: VERSION };
}
