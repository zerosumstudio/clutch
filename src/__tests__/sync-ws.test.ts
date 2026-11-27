import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StateSyncManager, type SyncManagerConfig } from '../sync'
import type { StoreError } from '../error'
import { WebSocketTransport } from '../transports/websocket'
import type { SyncTransport, TransportStatus } from '../transports/types'

interface TestState {
	count: number
	name: string
}

/*
 *   MOCK WEBSOCKET
 ***************************************************************************************************/
class MockWebSocket {
	static instances: MockWebSocket[] = []

	readyState = 0 // CONNECTING
	sent: string[] = []
	closed = false
	listeners: Record<string, Array<(event: any) => void>> = {}

	constructor(
		public url: string,
		public protocols?: string | string[],
	) {
		MockWebSocket.instances.push(this)
	}

	send(data: string): void {
		this.sent.push(data)
	}

	close(): void {
		this.closed = true
	}

	addEventListener(type: string, listener: (event: any) => void): void {
		;(this.listeners[type] ??= []).push(listener)
	}

	dispatch(type: string, event: any = {}): void {
		if (type === 'open') {
			this.readyState = 1
		}
		if (type === 'close') {
			this.readyState = 3
		}
		for (const listener of this.listeners[type] ?? []) {
			listener(event)
		}
	}

	static last(): MockWebSocket {
		return MockWebSocket.instances[MockWebSocket.instances.length - 1]!
	}
}

const createTransport = (
	config: Partial<ConstructorParameters<typeof WebSocketTransport>[0]> = {},
) =>
	new WebSocketTransport({
		url: 'wss://example.test/sync',
		webSocketCtor: MockWebSocket,
		...config,
	})

/*
 *   WEBSOCKET TRANSPORT
 ***************************************************************************************************/
describe('WebSocketTransport', () => {
	let statuses: TransportStatus[]

	beforeEach(() => {
		vi.useFakeTimers()
		MockWebSocket.instances = []
		statuses = []
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	const startConnected = (config: Record<string, unknown> = {}) => {
		const { onError, ...rest } = config
		const transport = createTransport(rest)
		if (typeof onError === 'function') {
			transport.onError(onError as (error: unknown) => void)
		}
		transport.onStatusChange(status => statuses.push(status))
		transport.start()
		MockWebSocket.last().dispatch('open')
		return transport
	}

	it('should connect on start and report status', () => {
		startConnected()

		expect(MockWebSocket.instances).toHaveLength(1)
		expect(MockWebSocket.last().url).toBe('wss://example.test/sync')
		expect(statuses).toEqual(['connecting', 'connected'])
	})

	it('should JSON-serialize outgoing and parse incoming messages', () => {
		const transport = startConnected()
		const handler = vi.fn()
		transport.onMessage(handler)

		transport.send({ type: 'state_update', state: { count: 1 } })
		expect(MockWebSocket.last().sent).toContain(
			JSON.stringify({ type: 'state_update', state: { count: 1 } }),
		)

		MockWebSocket.last().dispatch('message', {
			data: JSON.stringify({ type: 'patches', version: 3 }),
		})
		expect(handler).toHaveBeenCalledWith({ type: 'patches', version: 3 })
	})

	it('should drop malformed inbound frames', () => {
		const transport = startConnected()
		const handler = vi.fn()
		transport.onMessage(handler)

		expect(() => MockWebSocket.last().dispatch('message', { data: 'not json{' })).not.toThrow()
		expect(handler).not.toHaveBeenCalled()
	})

	it('should queue messages while disconnected and flush FIFO on open', () => {
		const transport = createTransport()
		transport.onStatusChange(status => statuses.push(status))
		transport.start()

		transport.send({ seq: 1 })
		transport.send({ seq: 2 })
		expect(MockWebSocket.last().sent).toHaveLength(0)

		MockWebSocket.last().dispatch('open')

		expect(MockWebSocket.last().sent).toEqual([
			JSON.stringify({ seq: 1 }),
			JSON.stringify({ seq: 2 }),
		])
	})

	it('should emit connected only after the queue is flushed', () => {
		const transport = createTransport()
		let sentAtConnect = -1
		transport.onStatusChange(status => {
			if (status === 'connected') {
				sentAtConnect = MockWebSocket.last().sent.length
			}
		})
		transport.start()
		transport.send({ seq: 1 })

		MockWebSocket.last().dispatch('open')

		expect(sentAtConnect).toBe(1)
	})

	it('should drop the oldest message on queue overflow and report it', () => {
		const onError = vi.fn()
		const transport = createTransport({ maxQueueSize: 2 })
		transport.onError(onError)
		transport.start()

		transport.send({ seq: 1 })
		transport.send({ seq: 2 })
		transport.send({ seq: 3 })

		MockWebSocket.last().dispatch('open')

		expect(MockWebSocket.last().sent).toEqual([
			JSON.stringify({ seq: 2 }),
			JSON.stringify({ seq: 3 }),
		])
		expect(onError).toHaveBeenCalled()
	})

	it('should reconnect with exponential backoff after close', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const transport = startConnected({ reconnect: { baseDelayMs: 500 } })

		MockWebSocket.last().dispatch('close')
		expect(statuses).toContain('disconnected')
		expect(MockWebSocket.instances).toHaveLength(1)

		// First retry after baseDelay * 2^0
		vi.advanceTimersByTime(500)
		expect(MockWebSocket.instances).toHaveLength(2)

		// Second retry window doubles
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(500)
		expect(MockWebSocket.instances).toHaveLength(2)
		vi.advanceTimersByTime(500)
		expect(MockWebSocket.instances).toHaveLength(3)

		// A connection that holds for a while starts the backoff over
		MockWebSocket.last().dispatch('open')
		vi.advanceTimersByTime(10_000)
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(500)
		expect(MockWebSocket.instances).toHaveLength(4)

		transport.destroy()
	})

	it('should keep backing off when the server accepts and then closes right away', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const transport = startConnected({ reconnect: { baseDelayMs: 100, maxDelayMs: 100_000 } })

		const delays: number[] = []

		for (let attempt = 0; attempt < 5; attempt++) {
			const before = MockWebSocket.instances.length
			MockWebSocket.last().dispatch('close')

			let waited = 0
			while (MockWebSocket.instances.length === before && waited < 100_000) {
				vi.advanceTimersByTime(50)
				waited += 50
			}

			delays.push(waited)
			MockWebSocket.last().dispatch('open')
		}

		expect(delays[4]).toBeGreaterThan(delays[1] as number)
		expect(delays[4]).toBeGreaterThanOrEqual(1600)

		transport.destroy()
	})

	it('should stop reconnecting after maxRetries', () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const onError = vi.fn()
		startConnected({ reconnect: { baseDelayMs: 100, maxRetries: 2 }, onError })

		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(100)
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(200)
		expect(MockWebSocket.instances).toHaveLength(3)

		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(60000)
		expect(MockWebSocket.instances).toHaveLength(3)
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('max retries') }),
		)
	})

	it('should not reconnect when reconnect is disabled or after destroy', () => {
		const transport = startConnected({ reconnect: false })
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(60000)
		expect(MockWebSocket.instances).toHaveLength(1)
		transport.destroy()

		MockWebSocket.instances = []
		const transport2 = startConnected({})
		transport2.destroy()
		MockWebSocket.last().dispatch('close')
		vi.advanceTimersByTime(60000)
		expect(MockWebSocket.instances).toHaveLength(1)
	})

	it('should send heartbeat pings and close on missing pong', () => {
		startConnected({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 400 })
		const socket = MockWebSocket.last()

		vi.advanceTimersByTime(1000)
		expect(socket.sent).toContain(JSON.stringify({ type: 'ping' }))

		vi.advanceTimersByTime(400)
		expect(socket.closed).toBe(true)
	})

	it('should intercept pongs without forwarding them to the handler', () => {
		const transport = startConnected({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 400 })
		const handler = vi.fn()
		transport.onMessage(handler)
		const socket = MockWebSocket.last()

		vi.advanceTimersByTime(1000)
		socket.dispatch('message', { data: JSON.stringify({ type: 'pong' }) })

		vi.advanceTimersByTime(400)
		expect(socket.closed).toBe(false)
		expect(handler).not.toHaveBeenCalled()
	})

	it('should append the auth token as a query parameter when asked to', async () => {
		const transport = createTransport({
			getAuthToken: async () => 'secret token',
			authMode: 'query',
		})
		transport.start()
		await vi.advanceTimersByTimeAsync(0)

		expect(MockWebSocket.last().url).toBe('wss://example.test/sync?token=secret%20token')
		transport.destroy()
	})

	it('should send the auth token as the first frame by default', async () => {
		const transport = createTransport({ getAuthToken: () => 'tok' })
		transport.start()
		transport.send({ seq: 1 })
		await vi.advanceTimersByTimeAsync(0)

		MockWebSocket.last().dispatch('open')

		expect(MockWebSocket.last().url).toBe('wss://example.test/sync')
		expect(MockWebSocket.last().sent[0]).toBe(JSON.stringify({ type: 'auth', token: 'tok' }))
		expect(MockWebSocket.last().sent[1]).toBe(JSON.stringify({ seq: 1 }))
		transport.destroy()
	})

	it('should hand transport errors to the sync manager handler as errors, never as raw events, and not log them', () => {
		const consoleError = vi.spyOn(console, 'error')
		const transport = createTransport()
		const handler = vi.fn()
		transport.onError(handler)
		transport.start()

		MockWebSocket.last().dispatch('error', { type: 'error' })

		expect(handler).toHaveBeenCalledWith(expect.any(Error))
		expect(consoleError).not.toHaveBeenCalled()
	})

	it('should stay silent about socket events after destroy', () => {
		const onError = vi.fn()
		const transport = createTransport()
		transport.onError(onError)
		transport.start()
		const socket = MockWebSocket.last()

		transport.destroy()
		socket.dispatch('error', { type: 'error' })

		expect(onError).not.toHaveBeenCalled()
	})

	it('should drop queued frames when the next connection uses a different token', async () => {
		let token = 'alice'
		const transport = createTransport({
			getAuthToken: () => token,
			reconnect: { baseDelayMs: 10, maxDelayMs: 10 },
		})
		transport.start()
		await vi.advanceTimersByTimeAsync(0)
		MockWebSocket.last().dispatch('open')
		MockWebSocket.last().dispatch('close')

		// Offline: this was written while alice was signed in
		transport.send({ owner: 'alice' })
		token = 'bob'
		await vi.advanceTimersByTimeAsync(20)
		MockWebSocket.last().dispatch('open')

		const frames = MockWebSocket.last().sent
		expect(frames[0]).toBe(JSON.stringify({ type: 'auth', token: 'bob' }))
		expect(frames).not.toContain(JSON.stringify({ owner: 'alice' }))
		transport.destroy()
	})

	it('should keep queued frames when the token is the same', async () => {
		const transport = createTransport({
			getAuthToken: () => 'alice',
			reconnect: { baseDelayMs: 10, maxDelayMs: 10 },
		})
		transport.start()
		await vi.advanceTimersByTimeAsync(0)
		MockWebSocket.last().dispatch('open')
		MockWebSocket.last().dispatch('close')

		transport.send({ owner: 'alice' })
		await vi.advanceTimersByTimeAsync(20)
		MockWebSocket.last().dispatch('open')

		expect(MockWebSocket.last().sent).toContain(JSON.stringify({ owner: 'alice' }))
		transport.destroy()
	})

	it('should drop an inbound frame over maxMessageChars before parsing it', () => {
		const onError = vi.fn()
		const transport = startConnected({ maxMessageChars: 100, onError })
		const handler = vi.fn()
		transport.onMessage(handler)

		MockWebSocket.last().dispatch('message', {
			data: JSON.stringify({ type: 'state_update', pad: 'x'.repeat(500) }),
		})
		MockWebSocket.last().dispatch('message', { data: JSON.stringify({ type: 'full_sync' }) })

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledWith({ type: 'full_sync' })
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('maxMessageChars') }),
		)
	})

	it('should report a frame that is not valid JSON, and keep going', () => {
		const transport = startConnected()
		const handler = vi.fn()
		const onError = vi.fn()
		transport.onMessage(handler)
		transport.onError(onError)

		MockWebSocket.last().dispatch('message', { data: 'not json{' })
		MockWebSocket.last().dispatch('message', { data: JSON.stringify({ type: 'full_sync' }) })

		expect(onError).toHaveBeenCalledWith(expect.any(Error))
		expect(handler).toHaveBeenCalledTimes(1)
	})

	it('should report once, through the handler, and have no config.onError', () => {
		const transport = createTransport()
		const onError = vi.fn()
		transport.onError(onError)
		transport.start()

		MockWebSocket.last().dispatch('error', { type: 'error' })

		expect(onError).toHaveBeenCalledTimes(1)
	})

	it('should be safe to send after destroy', () => {
		const transport = startConnected()
		transport.destroy()

		expect(() => transport.send({ seq: 1 })).not.toThrow()
	})
})

/*
 *   SERVER VERSION PROTOCOL (StateSyncManager)
 ***************************************************************************************************/
describe('StateSyncManager server-version ordering', () => {
	interface FakeTransport extends SyncTransport {
		sent: any[]
		deliver: (message: unknown) => void
		emitStatus: (status: TransportStatus) => void
	}

	let transport: FakeTransport
	let currentState: TestState
	let applied: Array<{ state: TestState; patches: any[] }>
	let errors: StoreError[]
	let ownInstanceId: string

	const createFakeTransport = (): FakeTransport => {
		let messageHandler: ((message: unknown) => void) | null = null
		let statusHandler: ((status: TransportStatus) => void) | null = null

		return {
			sent: [],
			send(message: unknown) {
				this.sent.push(message)
			},
			onMessage(handler) {
				messageHandler = handler
			},
			onStatusChange(handler) {
				statusHandler = handler
			},
			destroy: vi.fn(),
			deliver(message: unknown) {
				messageHandler?.(message)
			},
			emitStatus(status) {
				statusHandler?.(status)
			},
		}
	}

	const createManager = (config: Partial<SyncManagerConfig<TestState>> = {}) => {
		const manager = new StateSyncManager<TestState>(
			{
				channel: 'c',
				mode: 'state',
				debounceMs: 50,
				ignoreLocalChanges: false,
				maxClockSkewMs: 5 * 60 * 1000,
				pick: undefined,
				transport,
				...config,
			},
			{
				getState: () => currentState,
				applyRemote: (state, patches) => {
					applied.push({ state, patches })

					return true
				},
				onError: error => errors.push(error),
			},
		)

		// The first connect sends the initial full sync
		transport.emitStatus('connected')
		ownInstanceId = transport.sent[0].instanceId

		return manager
	}

	const versioned = (version: number, overrides: Record<string, unknown> = {}) => ({
		type: 'state_update',
		channel: 'c',
		instanceId: 'remote_instance',
		timestamp: Date.now(),
		state: { count: version, name: 'remote' },
		version,
		...overrides,
	})

	const fullSyncRequests = () => transport.sent.filter(m => m.type === 'full_sync')

	beforeEach(() => {
		transport = createFakeTransport()
		currentState = { count: 0, name: 'test' }
		applied = []
		errors = []
	})

	it('should apply in-order versioned updates', () => {
		createManager()

		transport.deliver(versioned(1))
		transport.deliver(versioned(2))

		expect(applied.map(a => a.state.count)).toEqual([1, 2])
	})

	it('should drop stale and duplicate versions', () => {
		createManager()

		transport.deliver(versioned(2))
		transport.deliver(versioned(2))
		transport.deliver(versioned(1))

		expect(applied).toHaveLength(1)
		expect(applied[0]?.state.count).toBe(2)
	})

	it('should advance the cursor on self-echo without applying', () => {
		createManager({ mode: 'patches' })

		transport.deliver(versioned(1, { instanceId: ownInstanceId }))
		expect(applied).toHaveLength(0)

		// Next remote patch at version 2 is in-order, not a gap
		transport.deliver(
			versioned(2, {
				type: 'patches',
				state: undefined,
				patches: [{ op: 'replace', path: ['count'], value: 5 }],
			}),
		)

		expect(applied).toHaveLength(1)
		expect(applied[0]?.state.count).toBe(5)
		expect(fullSyncRequests()).toHaveLength(1) // only the initial one
	})

	it('should drop gapped patches and request a resync exactly once', () => {
		createManager({ mode: 'patches' })

		transport.deliver(versioned(1))
		expect(fullSyncRequests()).toHaveLength(1)

		const gappedPatch = (version: number) =>
			versioned(version, {
				type: 'patches',
				state: undefined,
				patches: [{ op: 'replace', path: ['count'], value: version }],
			})

		transport.deliver(gappedPatch(5))
		transport.deliver(gappedPatch(6))

		expect(applied).toHaveLength(1) // only the initial state_update
		expect(fullSyncRequests()).toHaveLength(2) // exactly one resync request

		// Resync answer (versioned full state) recovers and clears the pending flag
		transport.deliver(versioned(7))
		expect(applied).toHaveLength(2)
		expect(applied[1]?.state.count).toBe(7)
	})

	it('should apply gapped full-state updates', () => {
		createManager()

		transport.deliver(versioned(1))
		transport.deliver(versioned(10))

		expect(applied.map(a => a.state.count)).toEqual([1, 10])
		expect(fullSyncRequests()).toHaveLength(1)
	})

	it('should reset the version cursor and resync on reconnect', () => {
		createManager()

		transport.deliver(versioned(5))
		expect(applied).toHaveLength(1)

		transport.emitStatus('connected')
		expect(fullSyncRequests()).toHaveLength(2)

		// Server restarted with a fresh counter: version 1 must be accepted again
		transport.deliver(versioned(1))
		expect(applied).toHaveLength(2)
	})

	it('should ignore timestamps on versioned messages', () => {
		createManager()

		transport.deliver(versioned(1, { timestamp: Date.now() - 999999 }))

		expect(applied).toHaveLength(1)
	})

	it('should still validate versioned payloads', () => {
		createManager()

		transport.deliver(
			versioned(1, { state: JSON.parse('{"count": 1, "name": "x", "__proto__": {}}') }),
		)

		expect(applied).toHaveLength(0)
		expect(errors[0]?.code).toBe('SYNC_REJECTED')
	})

	it('should answer full-sync requests regardless of clock skew', () => {
		createManager()
		currentState = { count: 42, name: 'current' }

		transport.deliver({
			type: 'full_sync',
			channel: 'c',
			instanceId: 'remote_instance',
			timestamp: Date.now() - 999999,
		})

		const updates = transport.sent.filter(m => m.type === 'state_update')
		expect(updates).toHaveLength(1)
		expect(updates[0].state.count).toBe(42)
	})

	it('should not answer its own echoed full-sync request', () => {
		createManager()

		transport.deliver({
			type: 'full_sync',
			channel: 'c',
			instanceId: ownInstanceId,
			timestamp: Date.now(),
		})

		expect(transport.sent.filter(m => m.type === 'state_update')).toHaveLength(0)
	})
})
