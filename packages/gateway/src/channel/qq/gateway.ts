import type { QqApi } from "./api.ts";

/** Gateway opcodes of the QQ bot protocol. */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** Intents bit for C2C (friend) messages. */
const INTENT_C2C = 1 << 25;

const DEFAULT_GATEWAY_URL = "wss://api.sgroup.qq.com/websocket";
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_RECONNECT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 45_000;
/** Message ids remembered for de-duplication after a resume replays a dispatch. */
const SEEN_LIMIT = 1_000;

export type QqLog = (level: "debug" | "info" | "warn" | "error", message: string) => void;
export type QqLogError = (message: string, error: unknown) => void;

/** A file the user sent with a message, before it is downloaded. */
export interface QqAttachmentRef {
	contentType?: string;
	url: string;
	filename?: string;
	size?: number;
}

/** One C2C message, as the gateway delivered it. */
export interface QqMessageEvent {
	/** Platform message id, used as the passive reply target. */
	id: string;
	/** The sender's openid; for C2C it is also the chat id. */
	openid: string;
	content: string;
	attachments: QqAttachmentRef[];
	/** Speech-to-text of a voice message, when QQ provides it. */
	transcript?: string;
}

export interface QqGatewayOptions {
	api: QqApi;
	log: QqLog;
	logError: QqLogError;
	/** Replaced in tests. */
	socketFactory?: (url: string) => WebSocket;
	reconnectDelayMs?: number;
}

interface GatewayPayload {
	op: number;
	d?: unknown;
	s?: number;
	t?: string;
}

interface HelloData {
	heartbeat_interval?: number;
}

interface ReadyData {
	session_id?: string;
}

interface MessageData {
	id?: string;
	content?: string;
	author?: { user_openid?: string };
	attachments?: Array<{
		content_type?: string;
		url?: string;
		filename?: string;
		size?: number;
	}>;
	asr_refer_text?: string;
}

/**
 * The QQ bot gateway WebSocket loop.
 *
 * Connects, identifies (or resumes an earlier session), heartbeats, dispatches C2C messages and
 * reconnects after every close. `start` never rejects: connection failures are logged and retried
 * after a short delay.
 */
export class QqGateway {
	private readonly api: QqApi;
	private readonly log: QqLog;
	private readonly logError: QqLogError;
	private readonly socketFactory: (url: string) => WebSocket;
	private readonly reconnectDelayMs: number;

	private running = false;
	private socket: WebSocket | undefined;
	private heartbeat: NodeJS.Timeout | undefined;
	private sessionId: string | undefined;
	private lastSeq: number | undefined;
	private handshaking = false;
	private wake: (() => void) | undefined;
	private readonly seen = new Set<string>();
	private readonly seenOrder: string[] = [];

	constructor(options: QqGatewayOptions) {
		this.api = options.api;
		this.log = options.log;
		this.logError = options.logError;
		this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
		this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_MS;
	}

	/** Connect and start dispatching; returns as soon as the loop is scheduled. */
	start(onMessage: (message: QqMessageEvent) => void): void {
		if (this.running) return;
		this.running = true;
		void this.run(onMessage);
	}

	/** Close the socket and stop reconnecting. */
	async stop(): Promise<void> {
		this.running = false;
		this.closeSocket(1000, "stopped");
		this.wakeUp();
	}

	private async run(onMessage: (message: QqMessageEvent) => void): Promise<void> {
		while (this.running) {
			try {
				const url = await this.gatewayUrl();
				await this.connect(url, onMessage);
			} catch (error) {
				if (this.running) this.logError("qq gateway connection failed", error);
			}
			this.closeSocket(1000, "reconnecting");
			if (!this.running) break;
			await this.sleep(this.reconnectDelayMs);
		}
	}

	/** Ask the API for a gateway URL, falling back to the documented one. */
	private async gatewayUrl(): Promise<string> {
		try {
			const response = await this.api.call<{ url?: string }>("GET", "/gateway");
			if (typeof response.url === "string" && response.url !== "") return response.url;
		} catch (error) {
			this.logError("qq gateway: could not fetch the gateway url", error);
		}
		return DEFAULT_GATEWAY_URL;
	}

	/** One connection: resolves when the socket closes, so the caller can reconnect. */
	private connect(url: string, onMessage: (message: QqMessageEvent) => void): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		let socket: WebSocket | undefined;
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog);
			this.clearHeartbeat();
			if (this.socket === socket) this.socket = undefined;
			resolve();
		};

		try {
			socket = this.socketFactory(url);
		} catch (error) {
			this.logError("qq gateway: could not open a socket", error);
			resolve();
			return promise;
		}

		this.socket = socket;
		this.handshaking = false;

		const watchdog = setTimeout(() => {
			this.log("warn", "qq gateway: no hello within 45s, reconnecting");
			this.closeSocket(4000, "handshake timeout");
			finish();
		}, CONNECT_TIMEOUT_MS);
		watchdog.unref();

		socket.addEventListener("message", (event) => {
			this.handleFrame(event.data, onMessage);
		});
		socket.addEventListener("close", (event) => {
			this.log("info", `qq gateway: closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
			finish();
		});
		socket.addEventListener("error", (event) => {
			this.logError("qq gateway: socket error", event);
			this.closeSocket(4000, "socket error");
			finish();
		});
		return promise;
	}

	private handleFrame(raw: unknown, onMessage: (message: QqMessageEvent) => void): void {
		const text = frameText(raw);
		if (text === undefined) return;

		let payload: GatewayPayload;
		try {
			payload = JSON.parse(text) as GatewayPayload;
		} catch {
			this.log("warn", "qq gateway: ignoring a frame that is not JSON");
			return;
		}

		switch (payload.op) {
			case OP_HELLO:
				this.onHello(payload.d);
				return;
			case OP_HEARTBEAT_ACK:
				return;
			case OP_RECONNECT:
				this.log("info", "qq gateway: reconnect requested");
				this.closeSocket(4000, "reconnect requested");
				return;
			case OP_INVALID_SESSION:
				this.log("warn", "qq gateway: session invalidated, identifying again");
				this.sessionId = undefined;
				this.lastSeq = undefined;
				this.closeSocket(4000, "invalid session");
				return;
			case OP_DISPATCH:
				this.onDispatch(payload, onMessage);
				return;
			default:
				return;
		}
	}

	private onHello(data: unknown): void {
		const interval = readNumber((data as HelloData | undefined)?.heartbeat_interval) ?? DEFAULT_HEARTBEAT_MS;
		this.startHeartbeat(interval);
		void this.handshake();
	}

	private startHeartbeat(intervalMs: number): void {
		this.clearHeartbeat();
		this.heartbeat = setInterval(() => {
			this.send({ op: OP_HEARTBEAT, d: this.lastSeq ?? null });
		}, intervalMs);
		this.heartbeat.unref();
	}

	private clearHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
	}

	/** Send op2 identify, or op6 resume when a session from an earlier connection is known. */
	private async handshake(): Promise<void> {
		if (this.handshaking) return;
		this.handshaking = true;
		try {
			const token = `QQBot ${await this.api.token()}`;
			if (this.sessionId !== undefined) {
				this.send({
					op: OP_RESUME,
					d: { token, session_id: this.sessionId, seq: this.lastSeq ?? 0 },
				});
				return;
			}
			this.send({
				op: OP_IDENTIFY,
				d: { token, intents: INTENT_C2C, shard: [0, 1], properties: {} },
			});
		} catch (error) {
			this.handshaking = false;
			this.logError("qq gateway: could not identify", error);
			this.closeSocket(4000, "identify failed");
		}
	}

	private onDispatch(payload: GatewayPayload, onMessage: (message: QqMessageEvent) => void): void {
		if (typeof payload.s === "number") this.lastSeq = payload.s;

		switch (payload.t) {
			case "READY": {
				const sessionId = (payload.d as ReadyData | undefined)?.session_id;
				if (typeof sessionId === "string" && sessionId !== "") {
					this.sessionId = sessionId;
					this.log("info", "qq gateway: ready");
				}
				return;
			}
			case "RESUMED":
				this.log("info", "qq gateway: session resumed");
				return;
			case "C2C_MESSAGE_CREATE": {
				const message = parseMessage(payload.d);
				if (message === undefined) return;
				if (!this.markSeen(message.id)) return;
				onMessage(message);
				return;
			}
			default:
				return;
		}
	}

	/** Remember a message id; false when it was already delivered. */
	private markSeen(id: string): boolean {
		if (this.seen.has(id)) return false;
		this.seen.add(id);
		this.seenOrder.push(id);
		if (this.seenOrder.length > SEEN_LIMIT) {
			const oldest = this.seenOrder.shift();
			if (oldest !== undefined) this.seen.delete(oldest);
		}
		return true;
	}

	private send(payload: unknown): void {
		const socket = this.socket;
		if (!socket || socket.readyState !== 1) return;
		try {
			socket.send(JSON.stringify(payload));
		} catch (error) {
			this.logError("qq gateway: could not send a frame", error);
		}
	}

	private closeSocket(code: number, reason: string): void {
		const socket = this.socket;
		this.socket = undefined;
		this.clearHeartbeat();
		if (!socket) return;
		try {
			socket.close(code, reason);
		} catch {
			// Already closed; nothing to do.
		}
	}

	private sleep(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		// Not unref'd: while reconnecting, this timer is the only thing keeping the daemon alive.
		const timer = setTimeout(() => {
			this.wake = undefined;
			resolve();
		}, ms);
		this.wake = () => {
			clearTimeout(timer);
			this.wake = undefined;
			resolve();
		};
		return promise;
	}

	private wakeUp(): void {
		const wake = this.wake;
		this.wake = undefined;
		wake?.();
	}
}

function frameText(raw: unknown): string | undefined {
	if (typeof raw === "string") return raw;
	if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
	if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
	return undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Turn a `C2C_MESSAGE_CREATE` payload into a message, or undefined when it lacks an author. */
function parseMessage(data: unknown): QqMessageEvent | undefined {
	const raw = data as MessageData | undefined;
	if (!raw) return undefined;
	const openid = raw.author?.user_openid;
	if (typeof openid !== "string" || openid === "") return undefined;
	const id = typeof raw.id === "string" ? raw.id : "";
	if (id === "") return undefined;

	const attachments: QqAttachmentRef[] = [];
	for (const attachment of raw.attachments ?? []) {
		if (typeof attachment.url !== "string" || attachment.url === "") continue;
		attachments.push({
			contentType: attachment.content_type,
			url: attachment.url.startsWith("//") ? `https:${attachment.url}` : attachment.url,
			filename: attachment.filename,
			size: readNumber(attachment.size),
		});
	}

	return {
		id,
		openid,
		content: typeof raw.content === "string" ? raw.content.trim() : "",
		attachments,
		transcript: typeof raw.asr_refer_text === "string" ? raw.asr_refer_text : undefined,
	};
}
