import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createStore } from '../core'
import { StoreError } from '../error'
import { autosave } from '../plugins/autosave'
import { history } from '../plugins/history'
import { immer } from '../immer'

interface TestState {
	count: number
}

const initialState = (): TestState => ({ count: 0 })

const INTERVAL = 1000

const deferred = <V = void>() => {
	let resolve!: (value: V) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<V>((res, rej) => {
		resolve = res
		reject = rej
	})

	return { promise, resolve, reject }
}

describe('plugins/autosave', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('requires a save function and a positive finite interval', () => {
		expect(() => autosave({ save: null as unknown as () => void })).toThrow(StoreError)
		expect(() => autosave({ save: () => {}, intervalMs: 0 })).toThrow('positive')
		expect(() => autosave({ save: () => {}, intervalMs: Number.NaN })).toThrow('positive')
		expect(() => autosave({ save: () => {}, intervalMs: Infinity })).toThrow('positive')
	})

	describe('dirty tracking and save', () => {
		it('marks dirty on commit, saves the current state, then resets', async () => {
			const save = vi.fn()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL }),
			)

			expect(store.hasUnsavedChanges()).toBe(false)

			store.set({ count: 3 })
			expect(store.hasUnsavedChanges()).toBe(true)

			await store.save()

			expect(save).toHaveBeenCalledWith({ count: 3 })
			expect(store.hasUnsavedChanges()).toBe(false)
		})

		it('skips the save call when nothing changed', async () => {
			const save = vi.fn()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL }),
			)

			await store.save()

			expect(save).not.toHaveBeenCalled()
		})

		it('does not mark a sync update as unsaved', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => {}, intervalMs: INTERVAL }),
			)

			store.replaceState({ count: 5 }, { source: 'sync' })

			expect(store.hasUnsavedChanges()).toBe(false)
		})

		it('marks undo as unsaved, since the saved copy is now ahead', async () => {
			const save = vi.fn()
			const store = createStore({ initialState: initialState() })
				.with(history<TestState>())
				.with(autosave<TestState>({ save, intervalMs: INTERVAL }))

			store.set({ count: 1 })
			await store.save()
			expect(store.hasUnsavedChanges()).toBe(false)

			store.undo()
			expect(store.hasUnsavedChanges()).toBe(true)

			await vi.advanceTimersByTimeAsync(INTERVAL)
			expect(save).toHaveBeenLastCalledWith({ count: 0 })
			expect(store.hasUnsavedChanges()).toBe(false)
		})

		it('marks reset as unsaved', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => {}, intervalMs: INTERVAL }),
			)

			store.set({ count: 1 })
			await store.save()

			store.reset()

			expect(store.hasUnsavedChanges()).toBe(true)
		})

		it('stays dirty and reports the error when save fails', async () => {
			const onError = vi.fn()
			const save = vi.fn(() => {
				throw new Error('server down')
			})
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(autosave<TestState>({ save, intervalMs: INTERVAL }))

			store.set({ count: 1 })

			await expect(store.save()).rejects.toThrow('Autosave failed: server down')
			expect(store.hasUnsavedChanges()).toBe(true)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'AUTOSAVE_FAILED' }),
				'autosave',
			)
		})

		it('keeps a change made during a save dirty, and saves it next', async () => {
			const first = deferred()
			const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
			const store = createStore({ initialState: initialState() })
				.with(immer())
				.with(autosave<TestState>({ save, intervalMs: INTERVAL }))

			store.mutate(draft => {
				draft.count = 1
			})
			const saving = store.save()

			store.mutate(draft => {
				draft.count = 2
			})
			first.resolve()
			await saving

			expect(save).toHaveBeenCalledWith({ count: 1 })
			expect(store.hasUnsavedChanges()).toBe(true)

			await store.save()

			expect(save).toHaveBeenLastCalledWith({ count: 2 })
			expect(store.hasUnsavedChanges()).toBe(false)
		})

		it('never runs two saves at once', async () => {
			let running = 0
			let peak = 0
			const save = vi.fn(async () => {
				running++
				peak = Math.max(peak, running)
				await new Promise(resolve => setTimeout(resolve, 100))
				running--
			})
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL }),
			)

			store.set({ count: 1 })
			const calls = [store.save(), store.save(), store.save()]
			await vi.advanceTimersByTimeAsync(500)
			await Promise.all(calls)

			expect(peak).toBe(1)
			expect(save).toHaveBeenCalledTimes(1)
		})

		it('does not overlap an interval tick with a slow manual save', async () => {
			let running = 0
			let peak = 0
			const save = vi.fn(async () => {
				running++
				peak = Math.max(peak, running)
				await new Promise(resolve => setTimeout(resolve, INTERVAL * 3))
				running--
			})
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL }),
			)

			store.set({ count: 1 })
			void store.save()
			store.set({ count: 2 })
			await vi.advanceTimersByTimeAsync(INTERVAL * 8)

			expect(peak).toBe(1)
			expect(store.hasUnsavedChanges()).toBe(false)
		})

		it('does not throw when the store is destroyed mid-save', async () => {
			const pending = deferred()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => pending.promise, intervalMs: INTERVAL }),
			)

			store.set({ count: 1 })
			const saving = store.save()
			store.destroy()
			pending.resolve()

			await expect(saving).resolves.toBeUndefined()
		})

		it('does not throw a TypeError when a save fails after destroy', async () => {
			const pending = deferred()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => pending.promise, intervalMs: INTERVAL }),
			)

			store.set({ count: 1 })
			const saving = store.save()
			store.destroy()
			pending.reject(new Error('late failure'))

			await expect(saving).rejects.toMatchObject({ code: 'AUTOSAVE_FAILED' })
		})
	})

	describe('status', () => {
		it('moves through saving to idle with a stable reference between changes', async () => {
			const pending = deferred()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => pending.promise, intervalMs: INTERVAL }),
			)
			const listener = vi.fn()
			store.subscribe(listener)

			expect(store.getAutosaveState()).toEqual({ status: 'idle', lastSavedAt: null })
			expect(store.getAutosaveState()).toBe(store.getAutosaveState())

			store.set({ count: 1 })
			const saving = store.save()
			expect(store.getAutosaveState().status).toBe('saving')

			pending.resolve()
			await saving

			const status = store.getAutosaveState()
			expect(status.status).toBe('idle')
			expect(status.lastSavedAt).toEqual(expect.any(Number))
			expect(listener).toHaveBeenCalled()
		})

		it('holds the error on failure', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({
					save: () => Promise.reject(new Error('nope')),
					intervalMs: INTERVAL,
				}),
			)

			store.set({ count: 1 })
			await store.save().catch(() => {})

			const status = store.getAutosaveState()
			expect(status.status).toBe('error')
			expect(status.status === 'error' && status.error.code).toBe('AUTOSAVE_FAILED')
		})
	})

	describe('interval', () => {
		it('saves automatically when dirty', async () => {
			const save = vi.fn()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL }),
			)

			store.set({ count: 1 })

			await vi.advanceTimersByTimeAsync(INTERVAL)

			expect(save).toHaveBeenCalledWith({ count: 1 })
			expect(store.hasUnsavedChanges()).toBe(false)
		})

		it('does nothing on ticks while clean', async () => {
			const save = vi.fn()
			createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL }),
			)

			await vi.advanceTimersByTimeAsync(INTERVAL * 3)

			expect(save).not.toHaveBeenCalled()
		})

		it('swallows tick failures after reporting them', async () => {
			const onError = vi.fn()
			const save = vi.fn(() => {
				throw new Error('flaky')
			})
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(autosave<TestState>({ save, intervalMs: INTERVAL }))

			store.set({ count: 1 })

			await vi.advanceTimersByTimeAsync(INTERVAL)

			expect(onError).toHaveBeenCalled()
			expect(store.hasUnsavedChanges()).toBe(true)
		})

		it('saves on an interval without a window', async () => {
			vi.stubGlobal('window', undefined)
			const save = vi.fn()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL }),
			)

			store.set({ count: 1 })
			await vi.advanceTimersByTimeAsync(INTERVAL)
			vi.unstubAllGlobals()

			expect(save).toHaveBeenCalledTimes(1)
		})

		it('stops saving after destroy', async () => {
			const save = vi.fn()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL }),
			)

			store.set({ count: 1 })
			store.destroy()

			await vi.advanceTimersByTimeAsync(INTERVAL * 2)

			expect(save).not.toHaveBeenCalled()
		})
	})

	describe('load', () => {
		it('applies server state, clears history and resets dirty', async () => {
			const store = createStore({ initialState: initialState() })
				.with(history<TestState>())
				.with(
					autosave<TestState>({
						save: () => {},
						load: () => ({ count: 99 }),
						intervalMs: INTERVAL,
					}),
				)

			store.set({ count: 1 })
			expect(store.canUndo()).toBe(true)

			await expect(store.load()).resolves.toBe(true)

			expect(store.getState()).toEqual({ count: 99 })
			expect(store.canUndo()).toBe(false)
			expect(store.hasUnsavedChanges()).toBe(false)
			expect(store.getAutosaveState().status).toBe('idle')
		})

		it('returns false when the server has nothing', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => {}, load: () => null, intervalMs: INTERVAL }),
			)

			await expect(store.load()).resolves.toBe(false)
			expect(store.getState().count).toBe(0)
			expect(store.getAutosaveState().status).toBe('idle')
		})

		it('returns false when no load function is configured', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => {}, intervalMs: INTERVAL }),
			)

			await expect(store.load()).resolves.toBe(false)
		})

		it('rejects, reports and records the error when load fails', async () => {
			const onError = vi.fn()
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(
					autosave<TestState>({
						save: () => {},
						load: () => {
							throw new Error('offline')
						},
						intervalMs: INTERVAL,
					}),
				)

			await expect(store.load()).rejects.toThrow('offline')
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'AUTOSAVE_FAILED',
					message: expect.stringContaining('offline'),
				}),
				'autosave',
			)
			expect(store.getAutosaveState().status).toBe('error')
		})
	})

	describe('autoStart', () => {
		it('does not run the interval when it is false, but still saves on request', async () => {
			const save = vi.fn()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save, intervalMs: INTERVAL, autoStart: false }),
			)

			store.set({ count: 1 })
			await vi.advanceTimersByTimeAsync(INTERVAL * 3)
			expect(save).not.toHaveBeenCalled()

			await store.save()
			expect(save).toHaveBeenCalledTimes(1)
		})

		it('reports a load failure under the same code as a save failure', async () => {
			const onError = vi.fn()
			const store = createStore({ initialState: initialState() })
				.with({ name: 'errors', onError })
				.with(
					autosave<TestState>({
						save: () => {},
						load: () => {
							throw new Error('offline')
						},
					}),
				)

			await store.load().catch(() => {})

			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ code: 'AUTOSAVE_FAILED' }),
				'autosave',
			)
		})
	})
})
