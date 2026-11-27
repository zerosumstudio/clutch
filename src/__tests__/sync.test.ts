import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createStore, type PluginContext } from '../core'
import type { Patch } from '../patch'
import { sync } from '../plugins/sync'
import { history } from '../plugins/history'
import { immer } from '../immer'
import type { StandardSchemaV1 } from '../plugins/standard-schema'
import type { SyncTransport, TransportStatus } from '../transports/types'

interface TestState {
	count: number
	name: string
}

const initialState = (): TestState => ({ count: 0, name: 'test' })

const CHANNEL = 'test-channel'

const testStateSchema = (): StandardSchemaV1<TestState> => ({
	'~standard': {
		version: 1,
		vendor: 'clutch-test',
		validate: value => {
			const state = value as TestState

			return typeof state?.count === 'number' && typeof state?.name === 'string'
				? { value: state }
				: { issues: [{ message: 'expected { count: number, name: string }' }] }
		},
	},
})

type SyncMessage = {
	type: 'state_update' | 'full_sync' | 'patches'
	channel: string
	instanceId: string
	timestamp: number
	state?: Partial<TestState>
	patches?: Patch[]
	description?: string
	version?: number
}

const createMockTransport = (options: { withStatus?: boolean } = {}) => {
	const sent: SyncMessage[] = []
	let messageHandler: ((message: unknown) => void) | null = null
	let statusHandler: ((status: TransportStatus) => void) | null = null
	let errorHandler: ((error: unknown) => void) | null = null

	return {
		sent,
		send: vi.fn((message: unknown) => {
			sent.push(message as SyncMessage)
		}),
		onMessage: (handler: (message: unknown) => void) => {
			messageHandler = handler
		},
		...(options.withStatus
			? {
					onStatusChange: (handler: (status: TransportStatus) => void) => {
						statusHandler = handler
					},
				}
			: {}),
		onError: (handler: (error: unknown) => void) => {
			errorHandler = handler
		},
		start: vi.fn(),
		destroy: vi.fn(),
		receive: (message: Partial<SyncMessage>) => {
			messageHandler?.(message)
		},
		setStatus: (status: TransportStatus) => {
			statusHandler?.(status)
		},
		fail: (error: unknown) => {
			errorHandler?.(error)
		},
	}
}

type MockTransport = ReturnType<typeof createMockTransport>

const remoteMessage = (overrides: Partial<SyncMessage>): Partial<SyncMessage> => ({
	channel: CHANNEL,
	instanceId: 'remote-instance',
	timestamp: Date.now(),
	...overrides,
})

// Two or more stores wired together, delivering whatever one sends to the others
const createBus = () => {
	const members: { transport: SyncTransport; deliver: (message: unknown) => void }[] = []
	const queue: { from: number; message: unknown }[] = []

	const join = (): SyncTransport => {
		const index = members.length
		const member = {
			deliver: (_message: unknown) => {},
			transport: {
				send: (message: unknown) => {
					queue.push({ from: index, message: structuredClone(message) })
				},
				onMessage: (handler: (message: unknown) => void) => {
					member.deliver = handler
				},
				destroy: () => {},
			} satisfies SyncTransport,
		}
		members.push(member)

		return member.transport
	}

	// Delivers everything queued, in order, and keeps going while that produces more
	const settle = (): void => {
		for (let round = 0; round < 10; round++) {
			vi.advanceTimersByTime(100)

			while (queue.length > 0) {
				const { from, message } = queue.shift()!

				members.forEach((member, index) => {
					if (index !== from) {
						member.deliver(message)
					}
				})
			}
		}
	}

	// Lets every member flush its debounce first, so their messages cross in flight
	const crossAndSettle = (): void => {
		vi.advanceTimersByTime(100)
		settle()
	}

	return { join, settle, crossAndSettle }
}

describe('plugins/sync', () => {
	let transport: MockTransport

	beforeEach(() => {
		transport = createMockTransport()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const setup = (config: Partial<Parameters<typeof sync<TestState>>[0]> = {}) =>
		createStore({ initialState: initialState() }).with(
			sync<TestState>({ channel: CHANNEL, transport, ...config }),
		)

	it('requires a channel', () => {
		expect(() => sync({} as never)).toThrow('channel')
		expect(() => sync({ channel: '' })).toThrow('channel')
	})

	it('starts the transport and requests a full sync on install', () => {
		setup()

		expect(transport.start).toHaveBeenCalled()
		expect(transport.sent[0]).toMatchObject({ type: 'full_sync', channel: CHANNEL })
		expect(transport.sent).toHaveLength(1)
	})

	it('requests the full sync once, when a status-aware transport connects', () => {
		const statusTransport = createMockTransport({ withStatus: true })
		createStore({ initialState: initialState() }).with(
			sync<TestState>({ channel: CHANNEL, transport: statusTransport }),
		)

		expect(statusTransport.sent).toHaveLength(0)

		statusTransport.setStatus('connected')

		expect(statusTransport.sent.filter(message => message.type === 'full_sync')).toHaveLength(1)
	})

	it('stamps the channel and instance on every message and sends no inversePatches', () => {
		const store = setup({ mode: 'patches' })

		store.set({ count: 1 })
		vi.advanceTimersByTime(50)

		const update = transport.sent.find(message => message.type === 'patches')
		expect(update).toMatchObject({ channel: CHANNEL, instanceId: expect.any(String) })
		expect(update).not.toHaveProperty('inversePatches')
	})

	it('broadcasts commits as state updates after the debounce', () => {
		const store = setup()

		store.set({ count: 1 }, 'increment')

		vi.advanceTimersByTime(50)

		const update = transport.sent.find(message => message.type === 'state_update')
		expect(update).toMatchObject({
			state: { count: 1, name: 'test' },
			description: 'increment',
		})
	})

	it('honours debounceMs', () => {
		const store = setup({ debounceMs: 200 })

		store.set({ count: 1 })
		vi.advanceTimersByTime(150)
		expect(transport.sent.some(message => message.type === 'state_update')).toBe(false)

		vi.advanceTimersByTime(50)
		expect(transport.sent.some(message => message.type === 'state_update')).toBe(true)
	})

	it('broadcasts patches in patches mode', () => {
		const store = setup({ mode: 'patches' })

		store.set({ count: 1 })

		vi.advanceTimersByTime(50)

		const update = transport.sent.find(message => message.type === 'patches')
		expect(update?.patches).toEqual([{ op: 'replace', path: ['count'], value: 1 }])
		expect(update?.state).toBeUndefined()
	})

	it('accumulates patches from rapid updates within the debounce window', () => {
		const store = setup({ mode: 'patches' })

		store.set({ count: 1 })
		store.set({ name: 'updated' })

		vi.advanceTimersByTime(50)

		const updates = transport.sent.filter(message => message.type === 'patches')
		expect(updates).toHaveLength(1)
		expect(updates[0]?.patches).toEqual([
			{ op: 'replace', path: ['count'], value: 1 },
			{ op: 'replace', path: ['name'], value: 'updated' },
		])
	})

	it('flushes a pending broadcast on destroy instead of dropping it', () => {
		const store = setup()

		store.set({ count: 5 })

		store.destroy()

		const update = transport.sent.find(message => message.type === 'state_update')
		expect(update).toMatchObject({ state: { count: 5, name: 'test' } })
	})

	it('applies a remote state update', () => {
		const store = setup()
		const listener = vi.fn()
		store.subscribe(listener)

		transport.receive(
			remoteMessage({ type: 'state_update', state: { count: 9, name: 'remote' } }),
		)

		expect(store.getState()).toEqual({ count: 9, name: 'remote' })
		expect(listener).toHaveBeenCalled()
	})

	it('ignores messages stamped for another channel', () => {
		const store = setup()

		transport.receive(
			remoteMessage({
				channel: 'someone-elses-store',
				type: 'state_update',
				state: { count: 9, name: 'leaked' },
			}),
		)
		transport.receive({
			...remoteMessage({ type: 'state_update', state: { count: 9 } }),
			channel: undefined,
		} as never)

		expect(store.getState()).toEqual(initialState())
	})

	it('keeps two stores on different channels apart, and never answers their full sync', () => {
		const a = setup()
		const before = transport.sent.length

		transport.receive(remoteMessage({ channel: 'other', type: 'full_sync' }))

		expect(transport.sent.length).toBe(before)
		expect(a.getState()).toEqual(initialState())
	})

	it('keeps undo history through a remote state update that touches other keys', () => {
		const store = createStore({ initialState: initialState() })
			.with(sync<TestState>({ channel: CHANNEL, transport }))
			.with(history<TestState>())

		store.set({ count: 1 })
		vi.advanceTimersByTime(50)
		expect(store.getHistoryInfo().length).toBe(1)

		transport.receive(
			remoteMessage({ type: 'state_update', state: { count: 1, name: 'remote' } }),
		)

		expect(store.getState().name).toBe('remote')
		expect(store.getHistoryInfo().length).toBe(1)
		expect(store.undo()).toBe(true)
		expect(store.getState()).toEqual({ count: 0, name: 'remote' })
	})

	it('applies remote patches without clearing history for untouched keys', () => {
		const store = createStore({ initialState: initialState() })
			.with(sync<TestState>({ channel: CHANNEL, transport, mode: 'patches' }))
			.with(history<TestState>())

		store.set({ count: 1 })
		vi.advanceTimersByTime(50)

		transport.receive(
			remoteMessage({
				type: 'patches',
				patches: [{ op: 'replace', path: ['name'], value: 'remote' }],
			}),
		)

		expect(store.getState().name).toBe('remote')
		expect(store.canUndo()).toBe(true)
	})

	it('drops a stale undo stack when remote patches touch a key it recorded', () => {
		interface ListState {
			list: string[]
		}
		const listTransport = createMockTransport()
		const store = createStore<ListState>({ initialState: { list: ['a', 'b'] } })
			.with(immer())
			.with(sync<ListState>({ channel: CHANNEL, transport: listTransport, mode: 'patches' }))
			.with(history<ListState>())

		store.mutate(draft => {
			draft.list.push('c')
		})
		vi.advanceTimersByTime(50)

		listTransport.receive(
			remoteMessage({
				type: 'patches',
				patches: [{ op: 'replace', path: ['list'], value: ['b'] }],
			}),
		)

		expect(store.getState().list).toEqual(['b'])
		expect(store.canUndo()).toBe(false)
		expect(store.undo()).toBe(false)
		expect(store.getState().list).toEqual(['b'])
	})

	it('does not rebroadcast a remote update it just applied', () => {
		setup()
		const sendsBefore = transport.sent.length

		transport.receive(
			remoteMessage({ type: 'state_update', state: { count: 9, name: 'remote' } }),
		)

		vi.advanceTimersByTime(100)

		expect(transport.sent.length).toBe(sendsBefore)
	})

	it('answers a full-sync request from another instance with its state', () => {
		const store = setup()

		store.set({ count: 3 })

		transport.receive(remoteMessage({ type: 'full_sync' }))

		const response = transport.sent.filter(message => message.type === 'state_update').pop()
		expect(response?.state).toEqual({ count: 3, name: 'test' })
	})

	it('broadcasts history undo to peers', () => {
		const store = createStore({ initialState: initialState() })
			.with(sync<TestState>({ channel: CHANNEL, transport }))
			.with(history<TestState>())

		store.set({ count: 1 }, 'increment')
		vi.advanceTimersByTime(50)

		store.undo()
		vi.advanceTimersByTime(50)

		const updates = transport.sent.filter(message => message.type === 'state_update')
		expect(updates.pop()?.state).toMatchObject({ count: 0 })
	})

	it('keeps full-state replaces from other plugins local', () => {
		let capturedCtx!: PluginContext<TestState>
		createStore({ initialState: initialState() })
			.with({
				name: 'devtools',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(sync<TestState>({ channel: CHANNEL, transport }))

		const sendsBefore = transport.sent.length

		capturedCtx.replaceState({ count: 5, name: 'time-travel' }, { source: 'devtools' })
		vi.advanceTimersByTime(100)

		expect(transport.sent.length).toBe(sendsBefore)
	})

	describe('what a remote message may contain', () => {
		it('rejects remote states carrying a __proto__ key, and reports it', () => {
			const onError = vi.fn()
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(sync<TestState>({ channel: CHANNEL, transport }))

			transport.receive(
				remoteMessage({
					type: 'state_update',
					state: JSON.parse('{"count":5,"__proto__":{"polluted":true}}'),
				}),
			)

			expect(store.getState().count).toBe(0)
			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'SYNC_REJECTED' }),
				'sync',
			)
		})

		it('accepts states that merely contain "__proto__" inside a string value', () => {
			const store = setup()

			transport.receive(
				remoteMessage({
					type: 'state_update',
					state: { count: 3, name: 'docs about __proto__ and constructor' },
				}),
			)

			expect(store.getState()).toEqual({
				count: 3,
				name: 'docs about __proto__ and constructor',
			})
		})

		it('accepts data keys named constructor and prototype in a state update', () => {
			interface Words {
				counts: Record<string, number>
			}
			const wordsTransport = createMockTransport()
			const store = createStore<Words>({ initialState: { counts: { hello: 1 } } }).with(
				sync<Words>({ channel: CHANNEL, transport: wordsTransport }),
			)

			wordsTransport.receive(
				remoteMessage({
					type: 'state_update',
					state: JSON.parse('{"counts":{"hello":1,"constructor":2,"prototype":3}}'),
				}),
			)

			expect(Object.keys(store.getState().counts)).toEqual([
				'hello',
				'constructor',
				'prototype',
			])
			expect(store.getState().counts.constructor).toBe(2)
			expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'prototype')).toBe(false)
		})

		it('accepts patches that address a data key named constructor', () => {
			interface Words {
				counts: Record<string, number>
			}
			const wordsTransport = createMockTransport()
			const store = createStore<Words>({ initialState: { counts: { hello: 1 } } }).with(
				sync<Words>({ channel: CHANNEL, transport: wordsTransport, mode: 'patches' }),
			)

			wordsTransport.receive(
				remoteMessage({
					type: 'patches',
					patches: [{ op: 'add', path: ['counts', 'constructor'], value: 2 }],
				}),
			)
			wordsTransport.receive(
				remoteMessage({
					timestamp: Date.now() + 1,
					type: 'patches',
					patches: [{ op: 'replace', path: ['counts', 'constructor'], value: 5 }],
				}),
			)

			expect(store.getState().counts.constructor).toBe(5)
			expect(Object.hasOwn(store.getState().counts, 'constructor')).toBe(true)
			expect(({} as Record<string, unknown>).constructor).toBe(Object)
		})

		it('rejects a patch path through __proto__', () => {
			const store = setup({ mode: 'patches' })

			transport.receive(
				remoteMessage({
					type: 'patches',
					patches: [{ op: 'add', path: ['__proto__', 'polluted'], value: true }],
				}),
			)

			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(store.getState()).toEqual(initialState())
		})

		it('rejects patch paths with array or object segments', () => {
			const store = setup({ mode: 'patches' })

			transport.receive(
				remoteMessage({
					type: 'patches',
					patches: [
						{ op: 'add', path: [['constructor'] as unknown as string], value: 1 },
					],
				}),
			)

			expect(store.getState()).toEqual(initialState())
		})

		it('rejects patches whose values carry a __proto__ key', () => {
			const store = setup({ mode: 'patches' })

			transport.receive(
				remoteMessage({
					type: 'patches',
					patches: [
						{
							op: 'replace',
							path: ['name'],
							value: JSON.parse('{"__proto__":{"polluted":true}}'),
						},
					],
				}),
			)

			expect(store.getState().name).toBe('test')
			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
		})

		it.each([[[1, 2]], [null], ['text']])('rejects a state that is %j', state => {
			const store = setup()

			transport.receive(
				remoteMessage({ type: 'state_update', state: state as unknown as TestState }),
			)

			expect(store.getState()).toEqual(initialState())
		})

		it('rejects a root patch that would replace the state with an array', () => {
			const store = setup({ mode: 'patches' })

			transport.receive(
				remoteMessage({
					type: 'patches',
					patches: [{ op: 'replace', path: [], value: [1] }],
				}),
			)

			expect(store.getState()).toEqual(initialState())
		})

		it('reports a malformed message', () => {
			const onError = vi.fn()
			createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(sync<TestState>({ channel: CHANNEL, transport }))

			transport.receive(null as never)

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'SYNC_REJECTED' }),
				'sync',
			)
		})
	})

	describe('clocks', () => {
		it('accepts messages within the clock-skew tolerance', () => {
			const store = setup()

			transport.receive(
				remoteMessage({
					type: 'state_update',
					state: { count: 7, name: 'slow-clock' },
					timestamp: Date.now() - 2 * 60 * 1000,
				}),
			)

			expect(store.getState().count).toBe(7)
		})

		it('reports messages outside the configured clock-skew tolerance', () => {
			const onError = vi.fn()
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(sync<TestState>({ channel: CHANNEL, transport, maxClockSkewMs: 1000 }))

			transport.receive(
				remoteMessage({
					type: 'state_update',
					state: { count: 7, name: 'skewed' },
					timestamp: Date.now() - 5000,
				}),
			)

			expect(store.getState().count).toBe(0)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'SYNC_REJECTED',
					message: expect.stringContaining('clock skew'),
				}),
				'sync',
			)
		})

		it('ignores non-versioned messages without a numeric timestamp', () => {
			const store = setup()

			transport.receive({
				type: 'state_update',
				channel: CHANNEL,
				instanceId: 'remote-instance',
				state: { count: 7, name: 'no-clock' },
			})

			expect(store.getState().count).toBe(0)
		})

		it('stamps its next message after one it read from a fast peer', () => {
			const store = setup()

			transport.receive(
				remoteMessage({
					type: 'state_update',
					state: { count: 1, name: 'fast' },
					timestamp: Date.now() + 2 * 60 * 1000,
				}),
			)
			const fastStamp = Date.now() + 2 * 60 * 1000

			store.set({ count: 2 })
			vi.advanceTimersByTime(50)

			const update = transport.sent.filter(message => message.type === 'state_update').pop()
			expect(update?.timestamp).toBeGreaterThan(fastStamp)
		})

		it('applies two peers that share a millisecond instead of dropping the second', () => {
			const store = setup({ mode: 'patches' })
			const timestamp = Date.now()

			transport.receive(
				remoteMessage({
					instanceId: 'peer-a',
					timestamp,
					type: 'patches',
					patches: [{ op: 'replace', path: ['count'], value: 1 }],
				}),
			)
			transport.receive(
				remoteMessage({
					instanceId: 'peer-b',
					timestamp,
					type: 'patches',
					patches: [{ op: 'replace', path: ['name'], value: 'second' }],
				}),
			)

			expect(store.getState()).toEqual({ count: 1, name: 'second' })
		})

		it('drops a message older than one already applied', () => {
			const store = setup()
			const now = Date.now()

			transport.receive(
				remoteMessage({
					timestamp: now,
					type: 'state_update',
					state: { count: 5, name: 'new' },
				}),
			)
			transport.receive(
				remoteMessage({
					timestamp: now - 1000,
					type: 'state_update',
					state: { count: 1, name: 'old' },
				}),
			)

			expect(store.getState()).toEqual({ count: 5, name: 'new' })
		})
	})

	describe('concurrent edits converge', () => {
		const pair = (mode: 'state' | 'patches') => {
			const bus = createBus()
			const make = () =>
				createStore<{ x: number; y: number; list: string[] }>({
					initialState: { x: 0, y: 0, list: [] },
				})
					.with(immer())
					.with(sync({ channel: CHANNEL, transport: bus.join(), mode }))
			const a = make()
			const b = make()

			// Let the join-time resync finish before the edits under test
			bus.settle()

			return { bus, a, b }
		}

		it.each(['state', 'patches'] as const)(
			'ends with the same state in %s mode when each edits a different key',
			mode => {
				const { bus, a, b } = pair(mode)

				a.set({ x: 1 })
				b.set({ y: 2 })
				bus.crossAndSettle()

				expect(a.getState()).toEqual(b.getState())
			},
		)

		it.each(['state', 'patches'] as const)(
			'ends with the same state in %s mode when both edit the same key',
			mode => {
				const { bus, a, b } = pair(mode)

				a.set({ x: 1 })
				b.set({ x: 2 })
				bus.crossAndSettle()

				expect(a.getState()).toEqual(b.getState())
			},
		)

		it('ends with the same list when both push in patches mode', () => {
			const { bus, a, b } = pair('patches')

			a.mutate(draft => {
				draft.list.push('a')
			})
			b.mutate(draft => {
				draft.list.push('b')
			})
			bus.crossAndSettle()

			expect(a.getState().list).toEqual(b.getState().list)
		})

		it('still propagates a single edit', () => {
			const { bus, a, b } = pair('patches')

			a.mutate(draft => {
				draft.list.push('a')
			})
			bus.settle()

			expect(b.getState().list).toEqual(['a'])
		})

		it('keeps converging across several rounds of crossing edits', () => {
			const { bus, a, b } = pair('state')

			for (let round = 1; round <= 5; round++) {
				a.set({ x: round })
				b.set({ y: round * 10 })
				bus.crossAndSettle()

				expect(a.getState()).toEqual(b.getState())
			}
		})
	})

	describe('pick', () => {
		interface Session {
			token: string
			theme: string
		}

		const sessionSetup = (mode: 'state' | 'patches' = 'state') => {
			const sessionTransport = createMockTransport()
			const store = createStore<Session>({
				initialState: { token: 'secret', theme: 'dark' },
			}).with(
				sync<Session>({
					channel: CHANNEL,
					transport: sessionTransport,
					mode,
					pick: state => ({ theme: state.theme }),
				}),
			)

			return { store, sessionTransport }
		}

		it('sends only the picked keys in state mode', () => {
			const { store, sessionTransport } = sessionSetup()

			store.set({ theme: 'light', token: 'rotated' })
			vi.advanceTimersByTime(50)

			const update = sessionTransport.sent.find(message => message.type === 'state_update')
			expect(update?.state).toEqual({ theme: 'light' })
			expect(JSON.stringify(sessionTransport.sent)).not.toContain('secret')
			expect(JSON.stringify(sessionTransport.sent)).not.toContain('rotated')
		})

		it('sends only patches for picked keys in patches mode', () => {
			const { store, sessionTransport } = sessionSetup('patches')

			store.set({ token: 'rotated' })
			vi.advanceTimersByTime(50)
			expect(sessionTransport.sent.some(message => message.type === 'patches')).toBe(false)

			store.set({ theme: 'light', token: 'again' })
			vi.advanceTimersByTime(50)

			const update = sessionTransport.sent.find(message => message.type === 'patches')
			expect(update?.patches).toEqual([{ op: 'replace', path: ['theme'], value: 'light' }])
		})

		it('answers a full sync with the picked state only', () => {
			const { sessionTransport } = sessionSetup()

			sessionTransport.receive(remoteMessage({ type: 'full_sync' }))

			const response = sessionTransport.sent.filter(m => m.type === 'state_update').pop()
			expect(response?.state).toEqual({ theme: 'dark' })
		})

		it('merges a peer state into the picked keys and ignores the rest', () => {
			const { store, sessionTransport } = sessionSetup()

			sessionTransport.receive(
				remoteMessage({
					type: 'state_update',
					state: { theme: 'light', token: 'attacker' } as Partial<TestState>,
				}),
			)

			expect(store.getState()).toEqual({ theme: 'light', token: 'secret' })
		})

		it('ignores peer patches for keys that are not picked', () => {
			const { store, sessionTransport } = sessionSetup('patches')

			sessionTransport.receive(
				remoteMessage({
					type: 'patches',
					patches: [
						{ op: 'replace', path: ['token'], value: 'attacker' },
						{ op: 'replace', path: ['theme'], value: 'light' },
					],
				}),
			)

			expect(store.getState()).toEqual({ theme: 'light', token: 'secret' })
		})
	})

	describe('schema guard', () => {
		const schemaSetup = (mode: 'state' | 'patches' = 'state') => {
			const onError = vi.fn()
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(
					sync<TestState>({
						channel: CHANNEL,
						transport,
						schema: testStateSchema(),
						mode,
					}),
				)

			return { store, onError }
		}

		it('applies a remote update that matches the schema', () => {
			const { store } = schemaSetup()

			transport.receive(
				remoteMessage({ type: 'state_update', state: { count: 5, name: 'ok' } }),
			)

			expect(store.getState()).toEqual({ count: 5, name: 'ok' })
		})

		it('drops a remote update that fails the schema and reports it', () => {
			const { store, onError } = schemaSetup()

			transport.receive(
				remoteMessage({
					type: 'state_update',
					state: { count: 'nope' } as unknown as TestState,
				}),
			)

			expect(store.getState()).toEqual(initialState())
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'SYNC_REJECTED',
					message: expect.stringContaining('failed the schema'),
				}),
				'sync',
			)
		})

		it('asks for the whole state when a patch fails the schema, instead of counting it as applied', () => {
			const { store } = schemaSetup('patches')
			const sentBefore = transport.sent.filter(message => message.type === 'full_sync').length

			transport.receive(
				remoteMessage({
					type: 'patches',
					patches: [{ op: 'replace', path: ['count'], value: 'nope' }],
				}),
			)

			expect(store.getState()).toEqual(initialState())
			expect(transport.sent.filter(message => message.type === 'full_sync')).toHaveLength(
				sentBefore + 1,
			)

			// The next patch from the same peer is still looked at, not skipped as already seen
			transport.receive(
				remoteMessage({
					timestamp: Date.now(),
					type: 'patches',
					patches: [{ op: 'replace', path: ['count'], value: 50 }],
				}),
			)

			expect(store.getState().count).toBe(50)
		})

		it('drops a remote update when the schema validates asynchronously', () => {
			const onError = vi.fn()
			const asyncSchema: StandardSchemaV1<TestState> = {
				'~standard': {
					version: 1,
					vendor: 'clutch-test',
					validate: () => Promise.resolve({ value: initialState() }),
				},
			}
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(sync<TestState>({ channel: CHANNEL, transport, schema: asyncSchema }))

			transport.receive(
				remoteMessage({ type: 'state_update', state: { count: 9, name: 'y' } }),
			)

			expect(store.getState()).toEqual(initialState())
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining('Async schema') }),
				'sync',
			)
		})
	})

	describe('errors reach onError', () => {
		it('reports a transport that throws on send, and keeps the store working', () => {
			const onError = vi.fn()
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(sync<TestState>({ channel: CHANNEL, transport }))
			transport.send.mockImplementation(() => {
				throw new Error('socket closed')
			})

			store.set({ count: 1 })
			vi.advanceTimersByTime(50)

			expect(store.getState().count).toBe(1)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'SYNC_FAILED' }),
				'sync',
			)
		})

		it('reports transport failures', () => {
			const onError = vi.fn()
			createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(sync<TestState>({ channel: CHANNEL, transport }))

			transport.fail(new Error('boom'))

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'SYNC_FAILED',
					message: expect.stringContaining('boom'),
				}),
				'sync',
			)
		})
	})

	describe('autoStart: false', () => {
		it('stays idle until startSync() is called', () => {
			const store = setup({ autoStart: false })

			store.set({ count: 1 })
			vi.advanceTimersByTime(100)

			expect(transport.start).not.toHaveBeenCalled()
			expect(transport.sent.length).toBe(0)

			store.startSync()

			expect(transport.start).toHaveBeenCalled()
			expect(transport.sent[0]).toMatchObject({ type: 'full_sync' })
		})

		it('startSync() is idempotent', () => {
			const store = setup({ autoStart: false })

			store.startSync()
			store.startSync()

			expect(transport.start).toHaveBeenCalledTimes(1)
		})
	})

	it('destroys the transport on store destroy', () => {
		const store = setup()

		store.destroy()

		expect(transport.destroy).toHaveBeenCalled()
	})
})

describe('inbound patches', () => {
	let transport: MockTransport

	beforeEach(() => {
		transport = createMockTransport()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const build = (config: Partial<Parameters<typeof sync<TestState>>[0]> = {}) => {
		const onError = vi.fn()
		const store = createStore({ initialState: initialState() })
			.with({ name: 'errors', onError })
			.with(sync<TestState>({ channel: CHANNEL, transport, ...config }))

		return { store, onError }
	}

	it('refuses patches in state mode', () => {
		const { store, onError } = build()

		transport.receive(
			remoteMessage({
				type: 'patches',
				patches: [{ op: 'replace', path: ['count'], value: 9 }],
			}),
		)

		expect(store.getState()).toEqual(initialState())
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'SYNC_REJECTED' }),
			'sync',
		)
	})

	it('rejects a patch that would stretch an array to billions of slots, in either mode', () => {
		for (const mode of ['patches', 'state'] as const) {
			const listTransport = createMockTransport()
			const onError = vi.fn()
			const store = createStore<{ list: number[] }>({ initialState: { list: [1] } })
				.with({ name: 'errors', onError })
				.with(
					sync<{ list: number[] }>({ channel: CHANNEL, transport: listTransport, mode }),
				)

			listTransport.receive(
				remoteMessage({
					type: 'patches',
					patches: [{ op: 'replace', path: ['list', 'length'], value: 4294967295 }],
				}),
			)

			expect(store.getState().list).toEqual([1])
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'SYNC_REJECTED' }),
				'sync',
			)
		}
	})

	it('reports an invalid patch as SYNC_REJECTED, with the original error as the cause', () => {
		const { onError } = build({ mode: 'patches' })

		transport.receive(
			remoteMessage({ type: 'patches', patches: [{ op: 'nope', path: ['count'] } as never] }),
		)

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({
				code: 'SYNC_REJECTED',
				cause: expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
			}),
			'sync',
		)
	})

	it('answers a patch that no longer fits with a resync, not an error', () => {
		const listTransport = createMockTransport()
		const onError = vi.fn()
		const store = createStore<{ list: number[] }>({ initialState: { list: [1] } })
			.with({ name: 'errors', onError })
			.with(
				sync<{ list: number[] }>({
					channel: CHANNEL,
					transport: listTransport,
					mode: 'patches',
				}),
			)
		const requestsBefore = listTransport.sent.filter(m => m.type === 'full_sync').length

		listTransport.receive(
			remoteMessage({
				type: 'patches',
				patches: [{ op: 'replace', path: ['list', 7], value: 2 }],
			}),
		)

		expect(store.getState().list).toEqual([1])
		expect(onError).not.toHaveBeenCalled()
		expect(console.error).not.toHaveBeenCalled()
		expect(listTransport.sent.filter(m => m.type === 'full_sync')).toHaveLength(
			requestsBefore + 1,
		)
	})

	it('keeps a peer-controlled message type out of the error', () => {
		const { onError } = build()

		transport.receive(remoteMessage({ type: 'x'.repeat(5000) as never }))

		expect(onError.mock.calls[0]?.[0].message.length).toBeLessThan(200)
	})
})

describe('schema output', () => {
	let transport: MockTransport

	beforeEach(() => {
		transport = createMockTransport()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	// Keeps only `count`, and turns a numeric string into a number, like zod's default object does
	const stripping: StandardSchemaV1<TestState> = {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate: value => {
				const input = value as Record<string, unknown>

				return { value: { count: Number(input.count), name: String(input.name) } }
			},
		},
	}

	it('applies what the schema returns, so keys it does not know never get in', () => {
		const store = createStore({ initialState: initialState() }).with(
			sync<TestState>({ channel: CHANNEL, transport, schema: stripping }),
		)

		transport.receive(
			remoteMessage({
				type: 'state_update',
				state: { count: '5', name: 'ok', isAdmin: true, accessToken: 'attacker' } as never,
			}),
		)

		expect(store.getState()).toEqual({ count: 5, name: 'ok' })
		expect(Object.keys(store.getState())).not.toContain('isAdmin')
	})

	it('hands history and peers the patches of what was applied', () => {
		const onExternalState = vi.fn()
		createStore({ initialState: initialState() })
			.with({ name: 'observer', onExternalState })
			.with(sync<TestState>({ channel: CHANNEL, transport, schema: stripping }))

		transport.receive(
			remoteMessage({
				type: 'state_update',
				state: { count: '5', name: 'test', extra: 1 } as never,
			}),
		)

		expect(onExternalState.mock.calls[0]?.[1].patches).toEqual([
			{ op: 'replace', path: ['count'], value: 5 },
		])
	})

	it('reports a rejected update with a count and paths, never the issue text', () => {
		const onError = vi.fn()
		const strict: StandardSchemaV1<TestState> = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: () => ({
					issues: [{ message: 'Invalid string: "tok_live_SECRET"', path: ['name'] }],
				}),
			},
		}
		createStore({ initialState: initialState() })
			.with({ name: 'errors', onError })
			.with(sync<TestState>({ channel: CHANNEL, transport, schema: strict }))

		transport.receive(remoteMessage({ type: 'state_update', state: { count: 1, name: 'x' } }))

		const error = onError.mock.calls[0]?.[0]
		expect(error.message).toContain('1 issue at name')
		expect(error.message).not.toContain('tok_live_SECRET')
		expect(error.cause[0].message).toContain('tok_live_SECRET')
	})
})

describe('sync ordering fields and limits', () => {
	let transport: MockTransport

	beforeEach(() => {
		transport = createMockTransport()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it.each([[Infinity], [NaN], [-1], [1.5], ['7'], [Number.MAX_SAFE_INTEGER + 2]])(
		'rejects the version %j instead of letting it freeze the cursor',
		version => {
			const store = createStore({ initialState: initialState() }).with(
				sync<TestState>({ channel: CHANNEL, transport }),
			)

			transport.receive(
				remoteMessage({
					type: 'state_update',
					state: { count: 1, name: 'x' },
					version: version as never,
				}),
			)
			transport.receive(
				remoteMessage({ type: 'state_update', state: { count: 2, name: 'y' }, version: 3 }),
			)

			expect(store.getState().count).toBe(2)
		},
	)

	it('does not answer a full sync when it is set to ignore local changes', () => {
		const store = createStore({ initialState: initialState() }).with(
			sync<TestState>({ channel: CHANNEL, transport, ignoreLocalChanges: true }),
		)
		store.set({ count: 5 })

		transport.receive(remoteMessage({ type: 'full_sync' }))
		vi.advanceTimersByTime(100)

		expect(transport.sent.filter(message => message.type === 'state_update')).toHaveLength(0)
	})

	it('sends during an edit that never pauses, at most ten debounce windows late', () => {
		const store = createStore({ initialState: initialState() }).with(
			sync<TestState>({ channel: CHANNEL, transport, debounceMs: 50 }),
		)

		for (let edit = 1; edit <= 30; edit++) {
			store.set({ count: edit })
			vi.advanceTimersByTime(20)
		}

		const updates = transport.sent.filter(message => message.type === 'state_update')
		expect(updates.length).toBeGreaterThan(0)
		expect(updates[0]?.state?.count).toBeLessThanOrEqual(26)
	})

	it('sends the picked state when a recipe replaced the root, which patches cannot filter', () => {
		interface Session {
			token: string
			theme: string
		}
		const sessionTransport = createMockTransport()
		const store = createStore<Session>({ initialState: { token: 't', theme: 'dark' } })
			.with(immer())
			.with(
				sync<Session>({
					channel: CHANNEL,
					transport: sessionTransport,
					mode: 'patches',
					pick: state => ({ theme: state.theme }),
				}),
			)

		store.mutate(() => ({ token: 'new', theme: 'light' }))
		vi.advanceTimersByTime(50)

		const update = sessionTransport.sent.find(message => message.type === 'state_update')
		expect(update?.state).toEqual({ theme: 'light' })
	})
})
