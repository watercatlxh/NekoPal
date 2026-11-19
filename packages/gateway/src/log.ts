type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, message: string): void {
	const timestamp = new Date().toISOString();
	process.stderr.write(`${timestamp} [nekopal] ${level}: ${message}\n`);
}

export type LogFn = typeof log;
export type LogErrorFn = typeof logError;

/** Log one line to stderr, prefixed with an ISO timestamp and the app name. */
export function log(level: Level, message: string): void {
	write(level, message);
}

/** Log an error with its message, keeping the stack in the log for unexpected failures. */
export function logError(message: string, error: unknown): void {
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	write("error", `${message}: ${detail}`);
}
