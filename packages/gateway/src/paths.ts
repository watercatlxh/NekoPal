import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Root of the user data directory: `NEKOPAL_HOME`, else `~/.nekopal`. */
export const HOME = getAgentDir();

export const SETTINGS_PATH = join(HOME, "settings.toml");
export const STATE_PATH = join(HOME, "state.json");
export const MEMORY_FILE = join(HOME, "memory", "MEMORY.md");
export const USER_FILE = join(HOME, "memory", "USER.md");
export const PENDING_DIR = join(HOME, "memory", "pending");
export const SKILLS_DIR = join(HOME, "skills");
export const CRON_JOBS_PATH = join(HOME, "cron", "jobs.json");
