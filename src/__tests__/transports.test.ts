import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StateSyncManager, type SyncManagerConfig } from '../sync'
import type { Patch } from '../patch'
import type { StoreError } from '../error'
import { BroadcastChannelTransport } from '../transports/broadcast-channel'
import type { SyncTransport } from '../transports/types'

interface TestState {
	count: number
	name: string
}

/*
 *   FAKE TRANSPORT
 ***************************************************************************************************/
interface FakeTransport extends SyncTransport {
	errors: unknown[]
	sent: any[]
	deliver: (message: unknown) => void
	emitStatus: (status: 'connecting' | 'connected' | 'disconnected') => void
	fail: (error: unknown) => void
}

function createFakeTransport(): FakeTransport {
	let messageHandler: ((message: unknown) => void) | null = null
	let statusHandler: ((status: any) => void) | null = null

	let errorHandler: ((error: unknown) => void) | null = null

	return {
		errors: [],
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
		onError(handler) {
			errorHandler = handler
		},
		destroy: vi.fn(),
		fail(error: unknown) {
			errorHandler?.(error)
		},
		deliver(message: unknown) {
			messageHandler?.(message)
		},
		emitStatus(status) {
			statusHandler?.(status)
		},
	}
}

/*
 *   BROADCAST CHANNEL TRANSPORT
 ***************************************************************************************************/
describe('BroadcastChannelTransport', () => {
	let mockChannel: any
	let messageListener: ((event: any) => void) | undefined

	beforeEach(() => {
		messageListener = undefined
		mockChannel = {
			postMessage: vi.fn(),
			close: vi.fn(),
			addEventListener: vi.fn((_type: string, cb: (event: any) => void) => {
				messageListener = cb
			}),
		}

		// Constructed with new, so it cannot be an arrow.
		globalThis.BroadcastChannel = vi.fn(function () {
			return mockChannel
		})
	})

	afterEach(() => {
		delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel
	})

	it('should create a channel with the configured name', () => {
		new BroadcastChannelTransport({ channel: 'custom-channel' })

		expect(globalThis.BroadcastChannel).toHaveBeenCalledWith('custom-channel')
	})

	it('should post messages on send', () => {
		const transport = new BroadcastChannelTransport({ channel: 'c' })
		const message = { type: 'state_update', payload: 1 }

		transport.send(message)

		expect(mockChannel.postMessage).toHaveBeenCalledWith(message)
	})

	it('should forward inbound messages to the registered handler', () => {
		const transport = new BroadcastChannelTransport({ channel: 'c' })
		const handler = vi.fn()

		transport.onMessage(handler)
		messageListener?.({ data: { type: 'full_sync' } })

		expect(handler).toHaveBeenCalledWith({ type: 'full_sync' })
	})

	it('should ignore inbound messages before a handler is registered', () => {
		new BroadcastChannelTransport({ channel: 'c' })

		expect(() => messageListener?.({ data: { type: 'full_sync' } })).not.toThrow()
	})

	it('should close the channel on destroy', () => {
		const transport = new BroadcastChannelTransport({ channel: 'c' })

		transport.destroy()

		expect(mockChannel.close).toHaveBeenCalled()
	})

	it('should be inert when BroadcastChannel is unsupported, and report it once a handler listens', () => {
		delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel
		const onError = vi.fn()

		expect(() => {
			const transport = new BroadcastChannelTransport({ channel: 'c' })
			transport.onError(onError)
			transport.send({ type: 'state_update' })
			transport.onMessage(vi.fn())
			transport.destroy()
		}).not.toThrow()
		expect(onError).toHaveBeenCalledTimes(1)
	})

	it('should report a send that throws instead of logging it', () => {
		const transport = new BroadcastChannelTransport({ channel: 'c' })
		const onError = vi.fn()
		transport.onError(onError)
		mockChannel.postMessage.mockImplementation(() => {
			throw new Error('detached')
		})

		transport.send({ type: 'state_update' })

		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'detached' }))
	})

	it('should not keep a Node process alive for an open channel', () => {
		mockChannel.unref = vi.fn()

		new BroadcastChannelTransport({ channel: 'c' })

		expect(mockChannel.unref).toHaveBeenCalled()
	})
})

/*
 *   STATE SYNC MANAGER + INJECTED TRANSPORT
 ***************************************************************************************************/
describe('StateSyncManager with injected transport', () => {
	let transport: FakeTransport
	let currentState: TestState
	let applied: Array<{ state: TestState; patches: Patch[] }>
	let errors: StoreError[]
	let accept: boolean

	const createManager = (config: Partial<SyncManagerConfig<TestState>> = {}) =>
		new StateSyncManager<TestState>(
			{
				channel: 'c',
				mode: 'state',
				debounceMs: 10,
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

					return accept
				},
				onError: error => errors.push(error),
			},
		)

	beforeEach(() => {
		vi.useFakeTimers()
		transport = createFakeTransport()
		currentState = { count: 0, name: 'test' }
		applied = []
		errors = []
		accept = true
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const remoteMessage = (overrides: Record<string, unknown>) => ({
		channel: 'c',
		instanceId: 'remote_instance',
		timestamp: Date.now(),
		...overrides,
	})

	it('should not construct a BroadcastChannel when a transport is injected', () => {
		const spy = vi.fn()
		globalThis.BroadcastChannel = spy

		createManager()

		expect(spy).not.toHaveBeenCalled()
		delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel
	})

	it('should wait for the connected status before requesting a full sync', () => {
		createManager()

		expect(transport.sent).toHaveLength(0)

		transport.emitStatus('connected')
		transport.emitStatus('connected')

		expect(transport.sent.filter(m => m.type === 'full_sync')).toHaveLength(2)
		expect(transport.sent[0].channel).toBe('c')
	})

	it('should send debounced state updates through the transport', () => {
		const syncManager = createManager()

		syncManager.broadcastChange([{ op: 'replace', path: ['count'], value: 1 }])
		currentState = { count: 2, name: 'test' }
		syncManager.broadcastChange([{ op: 'replace', path: ['count'], value: 2 }])
		expect(transport.sent.filter(m => m.type === 'state_update')).toHaveLength(0)

		vi.advanceTimersByTime(20)

		const updates = transport.sent.filter(m => m.type === 'state_update')
		expect(updates).toHaveLength(1)
		expect(updates[0].state).toEqual({ count: 2, name: 'test' })
	})

	it('should apply remote full-state updates with the keys that changed as patches', () => {
		createManager()

		transport.deliver(
			remoteMessage({ type: 'state_update', state: { count: 7, name: 'test' } }),
		)

		expect(applied).toHaveLength(1)
		expect(applied[0]?.state).toEqual({ count: 7, name: 'test' })
		expect(applied[0]?.patches).toEqual([{ op: 'replace', path: ['count'], value: 7 }])
	})

	it('should apply remote patches', () => {
		createManager({ mode: 'patches' })

		transport.deliver(
			remoteMessage({
				type: 'patches',
				patches: [{ op: 'replace', path: ['count'], value: 42 }],
			}),
		)

		expect(applied).toHaveLength(1)
		expect(applied[0]?.state.count).toBe(42)
	})

	it('should ignore messages from itself', () => {
		const syncManager = createManager()
		syncManager.broadcastChange([{ op: 'replace', path: ['count'], value: 1 }])
		vi.advanceTimersByTime(20)
		const ownInstanceId = transport.sent[0].instanceId

		transport.deliver(
			remoteMessage({
				type: 'state_update',
				instanceId: ownInstanceId,
				state: { count: 9, name: 'self' },
			}),
		)

		expect(applied).toHaveLength(0)
	})

	it('should reject messages outside the clock-skew tolerance, and report them', () => {
		createManager()

		transport.deliver(
			remoteMessage({
				type: 'state_update',
				timestamp: Date.now() - 6 * 60 * 1000,
				state: { count: 9, name: 'old' },
			}),
		)

		expect(applied).toHaveLength(0)
		expect(errors[0]?.code).toBe('SYNC_REJECTED')
	})

	it('should reject stale messages older than the last applied one', () => {
		createManager()
		const now = Date.now()

		transport.deliver(
			remoteMessage({ type: 'state_update', timestamp: now, state: { count: 1, name: 'a' } }),
		)
		transport.deliver(
			remoteMessage({
				type: 'state_update',
				timestamp: now - 1,
				state: { count: 2, name: 'b' },
			}),
		)

		expect(applied).toHaveLength(1)
		expect(applied[0]?.state.count).toBe(1)
	})

	it('should not count a rejected update as applied', () => {
		createManager()
		const now = Date.now()
		accept = false

		transport.deliver(
			remoteMessage({ type: 'state_update', timestamp: now, state: { count: 1, name: 'a' } }),
		)
		accept = true
		transport.deliver(
			remoteMessage({ type: 'state_update', timestamp: now, state: { count: 2, name: 'b' } }),
		)

		expect(applied).toHaveLength(2)
	})

	it('should reject states with a __proto__ key', () => {
		createManager()

		transport.deliver(
			remoteMessage({
				type: 'state_update',
				state: JSON.parse('{"count": 1, "name": "x", "__proto__": {}}'),
			}),
		)

		expect(applied).toHaveLength(0)
	})

	it('should accept states with keys named constructor', () => {
		createManager()

		transport.deliver(
			remoteMessage({
				type: 'state_update',
				state: JSON.parse('{"count": 1, "name": "x", "constructor": {"a": 1}}'),
			}),
		)

		expect(applied).toHaveLength(1)
	})

	it('should reject patches targeting __proto__ paths', () => {
		createManager({ mode: 'patches' })

		transport.deliver(
			remoteMessage({
				type: 'patches',
				patches: [{ op: 'replace', path: ['__proto__', 'polluted'], value: true }],
			}),
		)

		expect(applied).toHaveLength(0)
	})

	it('should answer full-sync requests with the current state', () => {
		createManager()
		currentState = { count: 33, name: 'current' }

		transport.deliver(remoteMessage({ type: 'full_sync' }))

		const updates = transport.sent.filter(m => m.type === 'state_update')
		expect(updates).toHaveLength(1)
		expect(updates[0].state).toEqual({ count: 33, name: 'current' })
	})

	it('should answer a full-sync request even when the sender clock is far off', () => {
		createManager()

		transport.deliver(remoteMessage({ type: 'full_sync', timestamp: 1 }))

		expect(transport.sent.filter(m => m.type === 'state_update')).toHaveLength(1)
	})

	it('should not answer its own full-sync request', () => {
		createManager()
		transport.emitStatus('connected')
		const own = transport.sent[0]

		transport.deliver(own)

		expect(transport.sent.filter(m => m.type === 'state_update')).toHaveLength(0)
	})

	it('should report transport errors as SYNC_FAILED', () => {
		createManager()

		transport.fail(new Error('down'))

		expect(errors[0]?.code).toBe('SYNC_FAILED')
	})

	it('should destroy the transport on destroy', () => {
		const syncManager = createManager()

		syncManager.destroy()

		expect(transport.destroy).toHaveBeenCalled()
	})
})
