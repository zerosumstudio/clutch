import type { SyncTransport } from './types'

/*
 *   BROADCAST CHANNEL TRANSPORT
 ***************************************************************************************************/
export interface BroadcastChannelTransportConfig {
	channel: string
}

export class BroadcastChannelTransport implements SyncTransport {
	private channel: BroadcastChannel | null = null
	private messageHandler: ((message: unknown) => void) | null = null
	private errorHandler: ((error: unknown) => void) | null = null
	private initError: unknown = null

	constructor(config: BroadcastChannelTransportConfig) {
		if (typeof BroadcastChannel === 'undefined') {
			this.initError = new Error(
				'BroadcastChannel is not supported in this environment, so multi-instance sync is disabled',
			)

			return
		}

		try {
			this.channel = new BroadcastChannel(config.channel)
			// Node keeps the process alive for an open channel
			;(this.channel as { unref?: () => void }).unref?.()

			this.channel.addEventListener('message', event => {
				this.messageHandler?.(event.data)
			})
		} catch (error) {
			this.initError = error
			this.channel = null
		}
	}

	public send(message: unknown): void {
		if (!this.channel) {
			return
		}

		try {
			this.channel.postMessage(message)
		} catch (error) {
			this.errorHandler?.(error)
		}
	}

	public onMessage(handler: (message: unknown) => void): void {
		this.messageHandler = handler
	}

	public onError(handler: (error: unknown) => void): void {
		this.errorHandler = handler

		// Construction happens before anyone can listen, so report what it hit now
		if (this.initError) {
			const error = this.initError
			this.initError = null
			handler(error)
		}
	}

	public destroy(): void {
		if (this.channel) {
			try {
				this.channel.close()
			} catch {
				// Ignore close errors
			}

			this.channel = null
		}

		this.messageHandler = null
		this.errorHandler = null
	}
}
