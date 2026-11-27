import type { SyncTransport, TransportStatus } from './types'

/*
 *   TYPES
 ***************************************************************************************************/
export interface ReconnectConfig {
	maxRetries?: number
	baseDelayMs?: number
	maxDelayMs?: number
}

export interface WebSocketTransportConfig {
	url: string
	protocols?: string | string[]
	webSocketCtor?: WebSocketCtor
	reconnect?: false | ReconnectConfig
	heartbeatIntervalMs?: number
	heartbeatTimeoutMs?: number
	maxQueueSize?: number
	/** Larger inbound frames are dropped before they are parsed. Defaults to 5 MB. */
	maxMessageChars?: number
	getAuthToken?: () => string | Promise<string>
	/** Defaults to `message`, which keeps the token out of the URL. */
	authMode?: 'query' | 'message'
}

export interface WebSocketLike {
	readyState: number
	send(data: string): void
	close(): void
	addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
}

export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike

const WS_OPEN = 1
const DEFAULT_MAX_MESSAGE_CHARS = 5 * 1024 * 1024
const DEFAULT_MAX_QUEUE_SIZE = 100
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000
// A connection has to survive this long before the reconnect backoff starts over
const STABLE_CONNECTION_MS = 10_000

/*
 *   WEBSOCKET TRANSPORT
 ***************************************************************************************************/
// The server must implement the stamping-relay protocol in docs/sync-protocol.md
export class WebSocketTransport implements SyncTransport {
	private socket: WebSocketLike | null = null
	private messageHandler: ((message: unknown) => void) | null = null
	private statusHandler: ((status: TransportStatus) => void) | null = null
	private errorHandler: ((error: unknown) => void) | null = null
	private queue: string[] = []
	private lastToken: string | undefined
	private isDestroyed = false
	private isStarted = false
	private reconnectAttempt = 0
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private stableTimer: ReturnType<typeof setTimeout> | null = null
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null
	private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null

	constructor(private config: WebSocketTransportConfig) {}

	public send(message: unknown): void {
		let data: string
		try {
			data = JSON.stringify(message)
		} catch (error) {
			this.report(error)

			return
		}

		if (this.socket && this.socket.readyState === WS_OPEN) {
			this.socket.send(data)
		} else {
			this.enqueue(data)
		}
	}

	public onMessage(handler: (message: unknown) => void): void {
		this.messageHandler = handler
	}

	public onStatusChange(handler: (status: TransportStatus) => void): void {
		this.statusHandler = handler
	}

	public onError(handler: (error: unknown) => void): void {
		this.errorHandler = handler
	}

	public start(): void {
		if (this.isStarted || this.isDestroyed) {
			return
		}

		this.isStarted = true
		void this.connect()
	}

	public destroy(): void {
		this.isDestroyed = true

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}

		this.stopHeartbeat()
		this.clearStableTimer()

		if (this.socket) {
			try {
				this.socket.close()
			} catch {
				// Ignore close errors
			}

			this.socket = null
		}

		this.queue = []
		this.messageHandler = null
		this.statusHandler = null
		this.errorHandler = null
	}

	/*
	 * CONNECTION LIFECYCLE
	 */
	private async connect(): Promise<void> {
		if (this.isDestroyed) {
			return
		}

		this.statusHandler?.('connecting')

		let url = this.config.url
		let authMessage: string | null = null

		try {
			if (this.config.getAuthToken) {
				const token = await this.config.getAuthToken()

				if (this.hasBeenDestroyed()) {
					return
				}

				// Frames queued under another token belong to that session, not this one
				if (this.lastToken !== undefined && this.lastToken !== token) {
					this.queue = []
				}

				this.lastToken = token

				if (this.config.authMode === 'query') {
					const separator = url.includes('?') ? '&' : '?'
					url = `${url}${separator}token=${encodeURIComponent(token)}`
				} else {
					authMessage = JSON.stringify({ type: 'auth', token })
				}
			}

			const Ctor =
				this.config.webSocketCtor ??
				(typeof WebSocket !== 'undefined' ? WebSocket : undefined)

			if (!Ctor) {
				this.report(new Error('WebSocket is not available in this environment'))

				return
			}

			const socket = this.config.protocols
				? new Ctor(url, this.config.protocols)
				: new Ctor(url)
			this.socket = socket

			socket.addEventListener('open', () => this.handleOpen(authMessage))
			socket.addEventListener('message', event => this.handleInbound(event.data))
			socket.addEventListener('close', () => this.handleClose())
			socket.addEventListener('error', () => {
				// A socket closed by destroy() still fires its events
				if (!this.isDestroyed) {
					this.report(new Error('WebSocket connection error'))
				}
			})
		} catch (error) {
			this.report(error)
			this.scheduleReconnect()
		}
	}

	// The transport can be destroyed while a token is awaited
	private hasBeenDestroyed(): boolean {
		return this.isDestroyed
	}

	private handleOpen(authMessage: string | null): void {
		if (this.isDestroyed || !this.socket) {
			return
		}

		// Backoff only starts over once the connection has held, so a server that accepts and
		// then closes can not be retried at the base delay forever
		this.clearStableTimer()
		this.stableTimer = setTimeout(() => {
			this.stableTimer = null
			this.reconnectAttempt = 0
		}, STABLE_CONNECTION_MS)

		if (authMessage) {
			this.socket.send(authMessage)
		}

		// Flush before emitting 'connected' so the manager's resync request
		// lands after (and supersedes) any stale queued updates
		const pending = this.queue
		this.queue = []
		for (const data of pending) {
			this.socket.send(data)
		}

		this.startHeartbeat()
		this.statusHandler?.('connected')
	}

	private handleInbound(data: unknown): void {
		this.clearHeartbeatDeadline()

		const raw = String(data)

		if (raw.length > (this.config.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS)) {
			this.report(new Error('WebSocket message is larger than maxMessageChars'))

			return
		}

		let message: unknown
		try {
			message = JSON.parse(raw)
		} catch {
			this.report(new Error('WebSocket frame is not valid JSON'))

			return
		}

		// Pongs are transport-level and never reach the manager
		if (
			message &&
			typeof message === 'object' &&
			(message as { type?: unknown }).type === 'pong'
		) {
			return
		}

		this.messageHandler?.(message)
	}

	private handleClose(): void {
		this.stopHeartbeat()
		this.clearStableTimer()
		this.socket = null

		if (this.isDestroyed) {
			return
		}

		this.statusHandler?.('disconnected')
		this.scheduleReconnect()
	}

	private scheduleReconnect(): void {
		if (this.isDestroyed || this.config.reconnect === false || this.reconnectTimer) {
			return
		}

		const reconnect = this.config.reconnect ?? {}
		const maxRetries = reconnect.maxRetries ?? Infinity
		const baseDelayMs = reconnect.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS
		const maxDelayMs = reconnect.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS

		if (this.reconnectAttempt >= maxRetries) {
			this.report(new Error('WebSocket reconnect gave up after max retries'))

			return
		}

		// Full jitter: random delay within an exponentially growing window
		const delay = Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** this.reconnectAttempt)
		this.reconnectAttempt++

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			void this.connect()
		}, delay)
	}

	/*
	 * QUEUE + HEARTBEAT
	 */
	private enqueue(data: string): void {
		const maxQueueSize = this.config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE

		if (this.queue.length >= maxQueueSize) {
			this.queue.shift()
			this.report(new Error('WebSocket offline queue overflow, dropped oldest message'))
		}

		this.queue.push(data)
	}

	private startHeartbeat(): void {
		const interval = this.config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS

		if (interval <= 0) {
			return
		}

		const timeout = this.config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS

		this.heartbeatTimer = setInterval(() => {
			if (!this.socket || this.socket.readyState !== WS_OPEN) {
				return
			}

			this.socket.send(JSON.stringify({ type: 'ping' }))

			if (!this.heartbeatDeadline) {
				this.heartbeatDeadline = setTimeout(() => {
					this.heartbeatDeadline = null
					this.report(new Error('WebSocket heartbeat timed out'))
					try {
						this.socket?.close()
					} catch {
						// Ignore close errors, handleClose drives reconnection anyway
					}
				}, timeout)
			}
		}, interval)
	}

	private clearHeartbeatDeadline(): void {
		if (this.heartbeatDeadline) {
			clearTimeout(this.heartbeatDeadline)
			this.heartbeatDeadline = null
		}
	}

	private clearStableTimer(): void {
		if (this.stableTimer) {
			clearTimeout(this.stableTimer)
			this.stableTimer = null
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}

		this.clearHeartbeatDeadline()
	}

	private report(error: unknown): void {
		this.errorHandler?.(error)
	}
}
