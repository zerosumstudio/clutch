import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createStore, type PluginContext } from '../core'
import { persist, type PersistStorage } from '../plugins/persist'
import { history } from '../plugins/history'
import type { StandardSchemaV1 } from '../plugins/standard-schema'

interface TestState {
	count: number
	name: string
	secret: string
}

const initialState = (): TestState => ({ count: 0, name: 'test', secret: 'hidden' })

const KEY = 'persist-test'

// setup.ts replaces window.localStorage with no-op mocks, so tests exercise
// the injectable storage seam instead
interface MemoryStorage extends PersistStorage {
	store: Map<string, string>
	setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>
}

const createMemoryStorage = (): MemoryStorage => {
	const store = new Map<string, string>()

	return {
		store,
		getItem: key => store.get(key) ?? null,
		setItem: vi.fn((key: string, value: string) => {
			store.set(key, value)
		}),
		removeItem: key => {
			store.delete(key)
		},
	}
}

const createSchema = (
	check: (value: unknown) => string | null,
): StandardSchemaV1<Partial<TestState>> => ({
	'~standard': {
		version: 1,
		vendor: 'test',
		validate: value => {
			const issue = check(value)

			return issue ? { issues: [{ message: issue }] } : { value: value as Partial<TestState> }
		},
	},
})

describe('plugins/persist', () => {
	let storage: MemoryStorage

	const readStored = (): { state: Partial<TestState>; timestamp: number } | null => {
		const raw = storage.store.get(KEY)

		return raw ? JSON.parse(raw) : null
	}

	const seedStored = (state: unknown, version?: number): void => {
		storage.store.set(KEY, JSON.stringify({ state, timestamp: Date.now(), version }))
	}

	beforeEach(() => {
		storage = createMemoryStorage()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('requires a key', () => {
		expect(() => persist({ key: '' })).toThrow('key is required')
	})

	describe('hydration', () => {
		it('hydrates on install, merging persisted partials over current state', () => {
			seedStored({ count: 42 })

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage }),
			)

			expect(store.getState()).toEqual({ count: 42, name: 'test', secret: 'hidden' })
			expect(store.isHydrated()).toBe(true)
		})

		it('does not write back to storage during hydration', () => {
			seedStored({ count: 42 })

			createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage }),
			)

			vi.runAllTimers()
			expect(storage.setItem).not.toHaveBeenCalled()
		})

		it('defers hydration until hydrate() is called', async () => {
			seedStored({ count: 42 })

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, autoStart: false }),
			)

			expect(store.getState().count).toBe(0)
			expect(store.isHydrated()).toBe(false)

			await expect(store.hydrate()).resolves.toBe(true)
			expect(store.getState().count).toBe(42)
			expect(store.isHydrated()).toBe(true)
		})

		it('hydrate() is one-shot and reports whether stored state was applied', async () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, autoStart: false }),
			)

			await expect(store.hydrate()).resolves.toBe(false)
			expect(store.isHydrated()).toBe(true)
			await expect(store.hydrate()).resolves.toBe(false)
		})

		it('notifies subscribers when hydration finds nothing, so isHydrated can be read', async () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, autoStart: false }),
			)
			const listener = vi.fn()
			store.subscribe(listener)

			await store.hydrate()

			expect(listener).toHaveBeenCalledTimes(1)
			expect(store.isHydrated()).toBe(true)
		})

		it('reports corrupt persisted data and keeps the defaults', () => {
			const onError = vi.fn()
			storage.store.set(KEY, 'not json {{')

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage }))

			expect(store.getState().count).toBe(0)
			expect(store.isHydrated()).toBe(true)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'PERSISTENCE_FAILED' }),
				'persist',
			)
		})

		it.each([['"abc"'], ['[1,2]']])('rejects a stored state of the wrong shape (%s)', raw => {
			const onError = vi.fn()
			storage.store.set(KEY, `{"state":${raw},"timestamp":1}`)

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage }))

			expect(store.getState()).toEqual(initialState())
			expect(onError).toHaveBeenCalled()
		})

		it('strips a __proto__ key while hydrating the safe ones', () => {
			storage.store.set(
				KEY,
				`{"state":{"count":5,"__proto__":{"polluted":true}},"timestamp":1}`,
			)

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage }),
			)

			expect(store.getState().count).toBe(5)
			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(Object.hasOwn(store.getState(), '__proto__')).toBe(false)
		})

		it('keeps legitimate keys named constructor and prototype', () => {
			interface Counts {
				counts: Record<string, number>
				constructor: string
			}
			storage.store.set(
				KEY,
				JSON.stringify({
					state: { counts: { constructor: 2, prototype: 3, ok: 1 }, constructor: 'kept' },
					timestamp: 1,
				}),
			)

			const store = createStore({
				initialState: { counts: {} } as unknown as Counts,
			}).with(persist<Counts>({ key: KEY, storage }))

			expect(store.getState().counts).toEqual({ constructor: 2, prototype: 3, ok: 1 })
			expect(Object.hasOwn(store.getState(), 'constructor')).toBe(true)
			expect(Object.getOwnPropertyDescriptor(store.getState(), 'constructor')?.value).toBe(
				'kept',
			)
		})

		it('clears installed history on deferred hydration (full-state replace)', async () => {
			seedStored({ count: 42 })

			const store = createStore({ initialState: initialState() })
				.with(history<TestState>())
				.with(persist<TestState>({ key: KEY, storage, autoStart: false }))

			store.set({ name: 'typed early' })
			expect(store.canUndo()).toBe(true)

			await store.hydrate()

			expect(store.getState().count).toBe(42)
			expect(store.canUndo()).toBe(false)
		})

		it('keeps changes made before a deferred hydrate() for keys the stored state lacks', async () => {
			seedStored({ count: 100 })

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, autoStart: false }),
			)

			store.set({ name: 'typed early' })
			await store.hydrate()

			expect(store.getState()).toMatchObject({ count: 100, name: 'typed early' })
		})
	})

	describe('writes before a deferred hydrate()', () => {
		it('does not write a change made before hydrate() over stored data, and keeps it over the stored value', async () => {
			seedStored({ count: 100, name: 'saved' })

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, autoStart: false, debounceMs: 300 }),
			)

			store.set({ count: 2 })
			vi.advanceTimersByTime(1000)

			expect(readStored()?.state).toEqual({ count: 100, name: 'saved' })

			await store.hydrate()

			expect(store.getState()).toMatchObject({ count: 2, name: 'saved' })
		})

		it('does not overwrite stored data with a remote update made before hydrate()', () => {
			let capturedCtx!: PluginContext<TestState>
			seedStored({ count: 100, name: 'saved' })

			createStore({ initialState: initialState() })
				.with({
					name: 'sync',
					onInit: (ctx: PluginContext<TestState>) => {
						capturedCtx = ctx
					},
				})
				.with(persist<TestState>({ key: KEY, storage, autoStart: false, debounceMs: 300 }))

			capturedCtx.replaceState({ count: 2, name: 'peer', secret: 'x' }, { source: 'sync' })
			vi.advanceTimersByTime(1000)

			expect(readStored()?.state).toEqual({ count: 100, name: 'saved' })
		})

		it('writes once after hydration when the state changed before it', async () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, autoStart: false, debounceMs: 300 }),
			)

			store.set({ count: 2 })
			await store.hydrate()
			vi.advanceTimersByTime(300)

			expect(readStored()?.state).toMatchObject({ count: 2 })
		})
	})

	describe('writing', () => {
		it('persists after the debounce window', () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 300 }),
			)

			store.set({ count: 1 })

			expect(readStored()).toBeNull()

			vi.advanceTimersByTime(300)

			expect(readStored()?.state).toMatchObject({ count: 1 })
		})

		it('coalesces rapid updates into one debounced write', () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 300 }),
			)

			store.set({ count: 1 })
			store.set({ count: 2 })
			store.set({ count: 3 })

			vi.advanceTimersByTime(300)

			expect(storage.setItem).toHaveBeenCalledTimes(1)
			expect(readStored()?.state).toMatchObject({ count: 3 })
		})

		it('flush() writes a pending persist immediately', () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 300 }),
			)

			store.set({ count: 1 })
			void store.flush()

			expect(readStored()?.state).toMatchObject({ count: 1 })
		})

		it('persists external state updates from other plugins', () => {
			let capturedCtx!: PluginContext<TestState>
			createStore({ initialState: initialState() })
				.with({
					name: 'sync',
					onInit: (ctx: PluginContext<TestState>) => {
						capturedCtx = ctx
					},
				})
				.with(persist<TestState>({ key: KEY, storage, debounceMs: 300 }))

			capturedCtx.replaceState(
				{ count: 9, name: 'remote', secret: 'hidden' },
				{ source: 'sync' },
			)

			vi.advanceTimersByTime(300)

			expect(readStored()?.state).toMatchObject({ count: 9, name: 'remote' })
		})

		it('flushes a pending write on destroy', () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 300 }),
			)

			store.set({ count: 5 })
			store.destroy()

			expect(readStored()?.state).toMatchObject({ count: 5 })
		})

		it('clearPersisted removes the stored entry without touching state', () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage }),
			)

			store.set({ count: 1 })
			void store.flush()
			expect(readStored()).not.toBeNull()

			void store.clearPersisted()

			expect(readStored()).toBeNull()
			expect(store.getState().count).toBe(1)
		})

		it('clearPersisted cancels a pending write instead of bringing the data back', () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 300 }),
			)

			store.set({ count: 1 })
			void store.clearPersisted()
			vi.advanceTimersByTime(1000)

			expect(readStored()).toBeNull()
		})
	})

	describe('pick', () => {
		it('stores only what pick returns', () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({
					key: KEY,
					storage,
					pick: ({ count, name }) => ({ count, name }),
				}),
			)

			store.set({ count: 1 })
			void store.flush()

			expect(readStored()?.state).toEqual({ count: 1, name: 'test' })
		})
	})

	describe('schema', () => {
		const positiveCount = createSchema(value =>
			(value as Partial<TestState>).count !== undefined && (value as TestState).count < 0
				? 'count must not be negative'
				: null,
		)

		it('applies stored state that passes the schema', () => {
			seedStored({ count: 5 })

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, schema: positiveCount }),
			)

			expect(store.getState().count).toBe(5)
		})

		it('discards stored state that fails the schema and reports it', () => {
			const onError = vi.fn()
			seedStored({ count: -5 })

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage, schema: positiveCount }))

			expect(store.getState().count).toBe(0)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'PERSISTENCE_FAILED',
					message: expect.stringContaining('1 issue at (root)'),
				}),
				'persist',
			)
		})

		it('checks the migrated state, not the stored one', () => {
			seedStored({ count: -5 }, 1)

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({
					key: KEY,
					storage,
					version: 2,
					schema: positiveCount,
					migrate: persisted => ({ ...(persisted as object), count: 7 }),
				}),
			)

			expect(store.getState().count).toBe(7)
		})
	})

	describe('async storage', () => {
		const createAsyncStorage = (delayMs: number) => {
			const data = new Map<string, string>()
			const wait = () => new Promise<void>(resolve => setTimeout(resolve, delayMs))
			const asyncStorage: PersistStorage = {
				getItem: async key => {
					await wait()

					return data.get(key) ?? null
				},
				setItem: async (key, value) => {
					await wait()
					data.set(key, value)
				},
				removeItem: async key => {
					await wait()
					data.delete(key)
				},
			}

			return { data, asyncStorage }
		}

		it('hydrates through a promise', async () => {
			const { data, asyncStorage } = createAsyncStorage(50)
			data.set(KEY, JSON.stringify({ state: { count: 42 }, timestamp: 1 }))

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage: asyncStorage }),
			)

			expect(store.isHydrated()).toBe(false)
			expect(store.getState().count).toBe(0)

			const hydrating = store.hydrate()
			await vi.advanceTimersByTimeAsync(50)

			await expect(hydrating).resolves.toBe(true)
			expect(store.getState().count).toBe(42)
			expect(store.isHydrated()).toBe(true)
		})

		it('shares one read between concurrent hydrate() calls', async () => {
			const { data, asyncStorage } = createAsyncStorage(50)
			data.set(KEY, JSON.stringify({ state: { count: 42 }, timestamp: 1 }))
			const getItem = vi.spyOn(asyncStorage, 'getItem')

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage: asyncStorage, autoStart: false }),
			)

			const first = store.hydrate()
			const second = store.hydrate()
			await vi.advanceTimersByTimeAsync(50)

			expect(await first).toBe(true)
			expect(await second).toBe(true)
			expect(getItem).toHaveBeenCalledTimes(1)
		})

		it('writes through a promise and reports a rejected write', async () => {
			const onError = vi.fn()
			const rejecting: PersistStorage = {
				getItem: () => Promise.resolve(null),
				setItem: () => Promise.reject(new Error('disk full')),
				removeItem: () => Promise.resolve(),
			}

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage: rejecting, debounceMs: 10 }))

			await vi.advanceTimersByTimeAsync(0)
			store.set({ count: 1 })
			await vi.advanceTimersByTimeAsync(10)

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'PERSISTENCE_FAILED' }),
				'persist',
			)
		})

		it('reports a failed read and still becomes hydrated', async () => {
			const onError = vi.fn()
			const failing: PersistStorage = {
				getItem: () => Promise.reject(new Error('locked')),
				setItem: () => {},
				removeItem: () => {},
			}

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage: failing }))

			await vi.advanceTimersByTimeAsync(0)

			expect(store.isHydrated()).toBe(true)
			expect(onError).toHaveBeenCalled()
		})
	})

	describe('failure handling', () => {
		it('emits an error and skips the write when state exceeds maxChars', () => {
			const onError = vi.fn()
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage, maxChars: 10 }))

			store.set({ name: 'way too large to fit' })
			void store.flush()

			expect(readStored()).toBeNull()
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'PERSISTENCE_FAILED' }),
				'persist',
			)
		})

		it('emits an error on quota exceeded', () => {
			const quotaError = new Error('quota')
			quotaError.name = 'QuotaExceededError'
			const failingStorage: PersistStorage = {
				getItem: () => null,
				setItem: () => {
					throw quotaError
				},
				removeItem: () => {},
			}

			const onError = vi.fn()
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage: failingStorage }))

			store.set({ count: 1 })
			void store.flush()

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringContaining('Storage quota exceeded'),
				}),
				'persist',
			)
		})

		it('reports a setItem that throws something other than a quota error', () => {
			const onError = vi.fn()
			const failingStorage: PersistStorage = {
				getItem: () => null,
				setItem: () => {
					throw new Error('SecurityError')
				},
				removeItem: () => {},
			}

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage: failingStorage }))

			store.set({ count: 1 })
			void store.flush()

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'PERSISTENCE_FAILED' }),
				'persist',
			)
		})

		it('reports state that cannot be serialised', () => {
			const onError = vi.fn()
			const store = createStore({ initialState: { big: 1n } })
				.with({ name: 'errors', onError })
				.with(persist<{ big: unknown }>({ key: KEY, storage }))

			store.set({ big: 2n })
			void store.flush()

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'PERSISTENCE_FAILED' }),
				'persist',
			)
		})
	})

	describe('versioning', () => {
		it('writes the configured version into the envelope', () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, version: 2 }),
			)
			store.set({ count: 1 })
			void store.flush()

			expect(readStored()).toMatchObject({ version: 2 })
		})

		it('migrates persisted state from an older version', () => {
			seedStored({ count: 41 }, 1)
			const migrate = vi.fn((old: unknown) => ({
				...(old as Partial<TestState>),
				count: ((old as Partial<TestState>).count ?? 0) + 1,
			}))

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, version: 2, migrate }),
			)

			expect(migrate).toHaveBeenCalledWith({ count: 41 }, 1)
			expect(store.getState().count).toBe(42)
		})

		it('discards mismatched state when no migrate is configured, and says so', () => {
			const onError = vi.fn()
			seedStored({ count: 41 }, 1)

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage, version: 2 }))

			expect(store.getState().count).toBe(0)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'PERSISTENCE_FAILED',
					message: expect.stringContaining('version 1'),
				}),
				'persist',
			)
		})

		it('hydrates unversioned state as version 0', () => {
			seedStored({ count: 41 })

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage }),
			)

			expect(store.getState().count).toBe(41)
		})

		it('reports a throwing migrate and keeps the stored data instead of overwriting it', () => {
			const onError = vi.fn()
			seedStored({ count: 41 }, 1)
			const original = storage.store.get(KEY)

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(
					persist<TestState>({
						key: KEY,
						storage,
						version: 2,
						debounceMs: 10,
						migrate: () => {
							throw new Error('bad migration')
						},
					}),
				)

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'PERSISTENCE_FAILED',
					message: expect.stringContaining('bad migration'),
				}),
				'persist',
			)

			store.set({ count: 5 })
			vi.advanceTimersByTime(100)

			expect(storage.store.get(KEY)).toBe(original)
		})

		it('writes again after clearPersisted following a failed migration', () => {
			seedStored({ count: 41 }, 1)

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError: () => {} })
				.with(
					persist<TestState>({
						key: KEY,
						storage,
						version: 2,
						debounceMs: 10,
						migrate: () => {
							throw new Error('bad migration')
						},
					}),
				)

			void store.clearPersisted()
			store.set({ count: 5 })
			vi.advanceTimersByTime(100)

			expect(readStored()?.state).toMatchObject({ count: 5 })
		})
	})

	describe('what hydration applies', () => {
		const stripping: StandardSchemaV1<Partial<TestState>> = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: value => {
					const input = value as Record<string, unknown>

					return { value: { count: Number(input.count) } }
				},
			},
		}

		it('applies the schema output, so stripped and coerced values are what lands', () => {
			seedStored({ count: '5', isAdmin: true, accessToken: 'planted' })

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, schema: stripping }),
			)

			expect(store.getState()).toEqual({ count: 5, name: 'test', secret: 'hidden' })
		})

		it('only reads back the keys that pick covers', () => {
			seedStored({ count: 5, name: 'planted', extra: 1 })

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, pick: ({ count }) => ({ count }) }),
			)

			expect(store.getState()).toEqual({ count: 5, name: 'test', secret: 'hidden' })
			expect(Object.keys(store.getState())).not.toContain('extra')
		})

		it('reports a schema failure without quoting what failed', () => {
			const onError = vi.fn()
			const quoting: StandardSchemaV1<Partial<TestState>> = {
				'~standard': {
					version: 1,
					vendor: 'test',
					validate: () => ({
						issues: [
							{
								message: 'Expected number, received "tok_live_SECRET"',
								path: ['count'],
							},
						],
					}),
				},
			}
			seedStored({ count: 'tok_live_SECRET' })

			createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage, schema: quoting }))

			const error = onError.mock.calls[0]?.[0]
			expect(error.message).toContain('1 issue at count')
			expect(error.message).not.toContain('tok_live_SECRET')
			expect(error.cause[0].message).toContain('tok_live_SECRET')
		})

		it('keeps the stored blob after a failed schema, until reset or clearPersisted', () => {
			seedStored({ count: -5 })
			const original = storage.store.get(KEY)

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError: () => {} })
				.with(
					persist<TestState>({
						key: KEY,
						storage,
						debounceMs: 10,
						schema: createSchema(value =>
							(value as TestState).count < 0 ? 'negative' : null,
						),
					}),
				)

			store.set({ count: 2 })
			vi.advanceTimersByTime(100)
			expect(storage.store.get(KEY)).toBe(original)

			void store.clearPersisted()
			store.set({ count: 3 })
			vi.advanceTimersByTime(100)
			expect(readStored()?.state).toMatchObject({ count: 3 })
		})

		it('does not block writes after a corrupt blob, since there is nothing in it to keep', () => {
			storage.store.set(KEY, 'not json')

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError: () => {} })
				.with(persist<TestState>({ key: KEY, storage, debounceMs: 10 }))

			store.set({ count: 2 })
			vi.advanceTimersByTime(100)

			expect(readStored()?.state).toMatchObject({ count: 2 })
		})

		it('does not quote the stored value when it is not valid JSON', () => {
			const onError = vi.fn()
			storage.store.set(KEY, 'eyJhbGciOiJIUzI1NiJ9.tok_live_SECRET')

			createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage }))

			const error = onError.mock.calls[0]?.[0]
			expect(error.message).not.toContain('eyJh')
			expect(error.message).not.toContain('tok_live')
			expect(error.cause).toBeInstanceOf(SyntaxError)
		})

		it('says the version is the wrong type instead of calling it version 0', () => {
			const onError = vi.fn()
			storage.store.set(
				KEY,
				JSON.stringify({ state: { count: 5 }, timestamp: 1, version: '2' }),
			)

			createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage, version: 2 }))

			expect(onError.mock.calls[0]?.[0].message).toContain('not a number')
		})

		it('ignores a stored value larger than maxChars', () => {
			const onError = vi.fn()
			seedStored({ count: 5, name: 'x'.repeat(2000) })

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(persist<TestState>({ key: KEY, storage, maxChars: 1024 }))

			expect(store.getState().count).toBe(0)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'PERSISTENCE_FAILED' }),
				'persist',
			)
		})
	})

	describe('reset after a failed migrate', () => {
		it('clears the protected data, because a reset is a request to start over', () => {
			seedStored({ accessToken: 'OLD', count: 41 }, 1)

			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError: () => {} })
				.with(
					persist<TestState>({
						key: KEY,
						storage,
						version: 2,
						debounceMs: 10,
						migrate: () => {
							throw new Error('bad migration')
						},
					}),
				)

			store.reset()
			vi.advanceTimersByTime(100)

			expect(readStored()?.state).toEqual(initialState())
			expect(JSON.stringify(readStored())).not.toContain('OLD')
		})
	})

	describe('async hydration against changes made while it was loading', () => {
		const delayed = (stored: unknown, delayMs: number): PersistStorage => ({
			getItem: () =>
				new Promise(resolve => {
					setTimeout(
						() => resolve(JSON.stringify({ state: stored, timestamp: 1 })),
						delayMs,
					)
				}),
			setItem: () => {},
			removeItem: () => {},
		})

		it('keeps a key set locally before it lands, and takes the rest from storage', async () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({
					key: KEY,
					storage: delayed({ count: 100, name: 'OLD-SESSION' }, 50),
				}),
			)

			store.set({ name: 'NEW-SESSION' })
			await vi.advanceTimersByTimeAsync(50)

			expect(store.getState()).toMatchObject({ count: 100, name: 'NEW-SESSION' })
		})

		it('writes the local value back, not the stored one', async () => {
			const written: string[] = []
			const base = delayed({ name: 'OLD-SESSION' }, 50)
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({
					key: KEY,
					debounceMs: 10,
					storage: {
						...base,
						setItem: (_key, value) => {
							written.push(value)
						},
					},
				}),
			)

			store.set({ name: 'NEW-SESSION' })
			await vi.advanceTimersByTimeAsync(100)

			expect(JSON.parse(written[written.length - 1] as string).state.name).toBe('NEW-SESSION')
		})

		it('lets stored values through for keys that were not touched', async () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({
					key: KEY,
					storage: delayed({ count: 9, name: 'stored' }, 50),
				}),
			)

			store.set({ count: 1 })
			await vi.advanceTimersByTimeAsync(50)

			expect(store.getState()).toMatchObject({ count: 1, name: 'stored' })
		})

		it('takes nothing from storage when the whole state was replaced first', async () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({
					key: KEY,
					storage: delayed({ count: 9, name: 'stored' }, 50),
				}),
			)

			store.replaceState({ count: 1, name: 'replaced', secret: 's' })
			await vi.advanceTimersByTimeAsync(50)

			expect(store.getState()).toEqual({ count: 1, name: 'replaced', secret: 's' })
		})
	})

	describe('async writes', () => {
		const slowFirstWrite = () => {
			const finished: string[] = []
			let calls = 0
			const storage: PersistStorage = {
				getItem: () => null,
				setItem: (_key, value) => {
					const delay = calls++ === 0 ? 100 : 10

					return new Promise<void>(resolve => {
						setTimeout(() => {
							finished.push(value)
							resolve()
						}, delay)
					})
				},
				removeItem: () => {},
			}

			return { storage, finished }
		}

		it('lets the last write win even when an earlier one is slower', async () => {
			const { storage: slow, finished } = slowFirstWrite()
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage: slow, debounceMs: 5 }),
			)

			store.set({ count: 1 })
			await vi.advanceTimersByTimeAsync(10)
			store.set({ count: 2 })
			await vi.advanceTimersByTimeAsync(300)

			expect(JSON.parse(finished[finished.length - 1] as string).state.count).toBe(2)
		})

		it('keeps one write in flight and only the newest of the rest', async () => {
			const { storage: slow } = slowFirstWrite()
			const setItem = vi.spyOn(slow, 'setItem')
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage: slow, debounceMs: 5 }),
			)

			store.set({ count: 1 })
			await vi.advanceTimersByTimeAsync(10)
			store.set({ count: 2 })
			await vi.advanceTimersByTimeAsync(10)
			store.set({ count: 3 })
			await vi.advanceTimersByTimeAsync(300)

			expect(setItem).toHaveBeenCalledTimes(2)
		})

		it('does not let a remove race ahead of a write', async () => {
			const order: string[] = []
			const storage: PersistStorage = {
				getItem: () => null,
				setItem: () =>
					new Promise<void>(resolve => {
						setTimeout(() => {
							order.push('set')
							resolve()
						}, 50)
					}),
				removeItem: () => {
					order.push('remove')
				},
			}
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, debounceMs: 5 }),
			)

			store.set({ count: 1 })
			await vi.advanceTimersByTimeAsync(10)
			void store.clearPersisted()
			await vi.advanceTimersByTimeAsync(200)

			expect(order).toEqual(['set', 'remove'])
		})
	})

	describe('flush and clearPersisted promises', () => {
		const slowStorage = () => {
			const events: string[] = []
			const storage: PersistStorage = {
				getItem: () => null,
				setItem: () =>
					new Promise<void>(resolve => {
						setTimeout(() => {
							events.push('set')
							resolve()
						}, 50)
					}),
				removeItem: () =>
					new Promise<void>(resolve => {
						setTimeout(() => {
							events.push('remove')
							resolve()
						}, 50)
					}),
			}

			return { storage, events }
		}

		it('flush() settles when the write does', async () => {
			const { storage: slow, events } = slowStorage()
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage: slow, debounceMs: 300 }),
			)

			store.set({ count: 1 })
			const flushing = store.flush()
			expect(events).toEqual([])

			await vi.advanceTimersByTimeAsync(50)
			await flushing

			expect(events).toEqual(['set'])
		})

		it('flush() with nothing pending resolves straight away, and waits for a write in flight', async () => {
			const { storage: slow, events } = slowStorage()
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage: slow, debounceMs: 5 }),
			)

			await expect(store.flush()).resolves.toBeUndefined()

			store.set({ count: 1 })
			await vi.advanceTimersByTimeAsync(10)
			const waiting = store.flush()
			await vi.advanceTimersByTimeAsync(50)
			await waiting

			expect(events).toEqual(['set'])
		})

		it('clearPersisted() settles when the removal does', async () => {
			const { storage: slow, events } = slowStorage()
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage: slow }),
			)

			const clearing = store.clearPersisted()
			expect(events).toEqual([])

			await vi.advanceTimersByTimeAsync(50)
			await clearing

			expect(events).toEqual(['remove'])
		})
	})

	describe('autoStart', () => {
		it('reads stored state on install by default, and not when it is false', async () => {
			seedStored({ count: 42 })

			const eager = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage }),
			)
			const lazy = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: KEY, storage, autoStart: false }),
			)

			expect(eager.getState().count).toBe(42)
			expect(lazy.getState().count).toBe(0)

			await lazy.hydrate()

			expect(lazy.getState().count).toBe(42)
		})
	})
})
