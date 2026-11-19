import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Root of the user data directory: `NEKOPAL_HOME`, else `~/.nekopal`. */
export const HOME = getAgentDir();

export const SETTINGS_PATH = join(HOME, "settings.toml");
export const SETTINGS_BACKUP_PATH = `${SETTINGS_PATH}.bak`;
export const AUTH_PATH = join(HOME, "auth.json");
export const MODELS_PATH = join(HOME, "models.json");
export const STATE_PATH = join(HOME, "state.json");
export const SOUL_PATH = join(HOME, "SOUL.md");
export const SESSIONS_DIR = join(HOME, "sessions");
export const MEMORY_DIR = join(HOME, "memory");
export const MEMORY_FILE = join(MEMORY_DIR, "MEMORY.md");
export const USER_FILE = join(MEMORY_DIR, "USER.md");
export const PENDING_DIR = join(MEMORY_DIR, "pending");
export const SKILLS_DIR = join(HOME, "skills");
export const CRON_DIR = join(HOME, "cron");
export const CRON_JOBS_PATH = join(CRON_DIR, "jobs.json");
