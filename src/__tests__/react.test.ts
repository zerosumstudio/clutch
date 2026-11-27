import { describe, it, expect, vi } from 'vitest'
import { render, renderHook, act, screen } from '@testing-library/react'
import { Activity, createElement, StrictMode, type ReactElement, type ReactNode } from 'react'
import { createStore, shallowEqual } from '../core'
import { createRegistry } from '../registry'
import { history } from '../plugins/history'
import { persist, type PersistStorage } from '../plugins/persist'
import { sync } from '../plugins/sync'
import { autosave } from '../plugins/autosave'
import {
	useStore,
	useSubscription,
	useHistory,
	useHydration,
	useAutosave,
	useRegistry,
	createStoreScope,
} from '../react'

interface TestState {
	count: number
	name: string
}

const flushMicrotasks = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const initialState = (): TestState => ({ count: 0, name: 'test' })

const createMemoryStorage = (): PersistStorage & { store: Map<string, string> } => {
	const store = new Map<string, string>()

	return {
		store,
		getItem: key => store.get(key) ?? null,
		setItem: (key, value) => {
			store.set(key, value)
		},
		removeItem: key => {
			store.delete(key)
		},
	}
}

describe('react', () => {
	describe('useStore', () => {
		it('returns state and re-renders on change', () => {
			const store = createStore({ initialState: initialState() })
			const { result } = renderHook(() => useStore(store))

			expect(result.current).toEqual({ count: 0, name: 'test' })

			act(() => {
				store.set({ count: 5 })
			})

			expect(result.current.count).toBe(5)
		})

		it('returns the selected slice', () => {
			const store = createStore({ initialState: initialState() })
			const { result } = renderHook(() => useStore(store, state => state.count))

			expect(result.current).toBe(0)

			act(() => {
				store.set({ count: 7 })
			})

			expect(result.current).toBe(7)
		})

		it('uses the latest selector when its identity changes every render', () => {
			const store = createStore({ initialState: initialState() })
			const { result, rerender } = renderHook(
				({ key }: { key: 'count' | 'name' }) => useStore(store, state => state[key]),
				{ initialProps: { key: 'count' as 'count' | 'name' } },
			)

			expect(result.current).toBe(0)

			rerender({ key: 'name' as const })

			expect(result.current).toBe('test')
		})

		it('suppresses re-renders through a custom equality function', () => {
			const store = createStore({ initialState: initialState() })
			let renders = 0

			renderHook(() => {
				renders++

				return useStore(
					store,
					state => ({ count: state.count }),
					(a, b) => a.count === b.count,
				)
			})

			const rendersBefore = renders

			act(() => {
				store.set({ name: 'changed' })
			})

			expect(renders).toBe(rendersBefore)
		})

		it('does not re-render when an unrelated part of state changes', () => {
			const store = createStore({ initialState: initialState() })
			let renders = 0

			renderHook(() => {
				renders++

				return useStore(store, state => state.count)
			})

			const rendersBefore = renders

			act(() => {
				store.set({ name: 'changed' })
			})

			expect(renders).toBe(rendersBefore)
		})

		it('does not loop on a selector that returns a new object, and keeps the reference with shallowEqual', () => {
			const store = createStore({ initialState: initialState() })
			const seen: object[] = []

			renderHook(() => {
				const picked = useStore(store, state => ({ count: state.count }), shallowEqual)
				seen.push(picked)

				return picked
			})

			act(() => {
				store.set({ name: 'unrelated' })
			})
			act(() => {
				store.set({ count: 1 })
			})

			expect(new Set(seen).size).toBe(2)
			expect(seen[seen.length - 1]).toEqual({ count: 1 })
		})

		it('re-renders an inline object selector without looping when it has no isEqual', () => {
			const store = createStore({ initialState: initialState() })

			const { result } = renderHook(() => useStore(store, state => state.count + 1))

			act(() => {
				store.set({ count: 1 })
			})

			expect(result.current).toBe(2)
		})

		it('works under StrictMode', () => {
			const store = createStore({ initialState: initialState() })
			const { result } = renderHook(() => useStore(store, state => state.count), {
				wrapper: StrictMode,
			})

			act(() => {
				store.set({ count: 3 })
			})

			expect(result.current).toBe(3)
		})
	})

	describe('useSubscription', () => {
		it('invokes the callback on changes and stops after unmount', () => {
			const store = createStore({ initialState: initialState() })
			const callback = vi.fn()
			const { unmount } = renderHook(() => useSubscription(store, callback))

			act(() => {
				store.set({ count: 1 })
			})

			expect(callback).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))

			unmount()
			callback.mockClear()

			act(() => {
				store.set({ count: 2 })
			})

			expect(callback).not.toHaveBeenCalled()
		})
	})

	describe('useRegistry', () => {
		it('returns combined state and re-renders when a member changes', () => {
			const registry = createRegistry({
				counter: createStore({ initialState: initialState() }),
			})
			const { result } = renderHook(() => useRegistry(registry))

			expect(result.current.counter.count).toBe(0)

			act(() => {
				registry.stores.counter.set({ count: 4 })
			})

			expect(result.current.counter.count).toBe(4)
		})

		it('re-renders only when the selected slice changes', () => {
			const registry = createRegistry({
				a: createStore({ initialState: initialState() }),
				b: createStore({ initialState: initialState() }),
			})
			let renders = 0

			const { result } = renderHook(() => {
				renders++

				return useRegistry(registry, state => state.a.count)
			})

			const rendersBefore = renders

			act(() => {
				registry.stores.b.set({ count: 9 })
			})
			expect(renders).toBe(rendersBefore)

			act(() => {
				registry.stores.a.set({ count: 2 })
			})
			expect(result.current).toBe(2)
		})
	})

	describe('useHistory', () => {
		it('tracks history info and drives undo/redo', () => {
			const store = createStore({ initialState: initialState() }).with(history<TestState>())
			const { result } = renderHook(() => useHistory(store))

			expect(result.current.canUndo).toBe(false)

			act(() => {
				store.set({ count: 1 }, 'increment')
			})

			expect(result.current.canUndo).toBe(true)
			expect(result.current.lastDescription).toBe('increment')

			act(() => {
				result.current.undo()
			})

			expect(store.getState().count).toBe(0)
			expect(result.current.canUndo).toBe(false)
			expect(result.current.canRedo).toBe(true)

			act(() => {
				result.current.redo()
			})

			expect(store.getState().count).toBe(1)
		})

		it('updates after clearHistory()', () => {
			const store = createStore({ initialState: initialState() }).with(history<TestState>())
			const { result } = renderHook(() => useHistory(store))

			act(() => {
				store.set({ count: 1 })
			})
			expect(result.current.canUndo).toBe(true)

			act(() => {
				result.current.clearHistory()
			})

			expect(result.current.canUndo).toBe(false)
			expect(store.canUndo()).toBe(false)
		})
	})

	describe('useHydration', () => {
		it('hydrates a deferred persist store on mount', () => {
			const storage = createMemoryStorage()
			storage.store.set(
				'react-test',
				JSON.stringify({ state: { count: 42 }, timestamp: Date.now() }),
			)

			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({ key: 'react-test', storage, autoStart: false }),
			)

			expect(store.isHydrated()).toBe(false)

			const { result } = renderHook(() => useHydration(store))

			expect(result.current.isHydrated).toBe(true)
			expect(store.getState().count).toBe(42)
		})

		it('flips isHydrated when nothing is stored', async () => {
			const store = createStore({ initialState: initialState() }).with(
				persist<TestState>({
					key: 'react-empty',
					storage: createMemoryStorage(),
					autoStart: false,
				}),
			)

			const { result } = renderHook(() => useHydration(store))

			await act(async () => {})

			expect(store.isHydrated()).toBe(true)
			expect(result.current.isHydrated).toBe(true)
		})
	})

	describe('useAutosave', () => {
		it('saves, tracks lastSavedAt and clears the unsaved flag', async () => {
			const save = vi.fn()
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save }),
			)
			const { result } = renderHook(() => useAutosave(store))

			expect(result.current.hasUnsavedChanges).toBe(false)
			expect(result.current.status).toBe('idle')

			act(() => {
				store.set({ count: 1 })
			})
			expect(result.current.hasUnsavedChanges).toBe(true)

			await act(async () => {
				await result.current.save()
			})

			expect(save).toHaveBeenCalledWith({ count: 1, name: 'test' })
			expect(result.current.hasUnsavedChanges).toBe(false)
			expect(result.current.status).toBe('idle')
			expect(result.current.lastSavedAt).toEqual(expect.any(Number))
		})

		it('shows a save failure as an error status, shared by every component', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({
					save: () => {
						throw new Error('server down')
					},
				}),
			)
			const first = renderHook(() => useAutosave(store))
			const second = renderHook(() => useAutosave(store))

			act(() => {
				store.set({ count: 1 })
			})

			await act(async () => {
				await first.result.current.save().catch(() => {})
			})

			for (const hook of [first, second]) {
				expect(hook.result.current.status).toBe('error')
				expect(
					hook.result.current.status === 'error' && hook.result.current.error.code,
				).toBe('AUTOSAVE_FAILED')
				expect(hook.result.current.hasUnsavedChanges).toBe(true)
			}
		})

		it('shows a load failure as an error status', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({
					save: () => {},
					load: () => {
						throw new Error('offline')
					},
				}),
			)
			const { result } = renderHook(() => useAutosave(store))

			await act(async () => {
				await result.current.load().catch(() => {})
			})

			expect(result.current.status).toBe('error')
		})

		it('loads from the server through the hook', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({
					save: () => {},
					load: () => ({ count: 99, name: 'server' }),
				}),
			)
			const { result } = renderHook(() => useAutosave(store))

			await act(async () => {
				await expect(result.current.load()).resolves.toBe(true)
			})

			expect(store.getState()).toEqual({ count: 99, name: 'server' })
			expect(result.current.lastSavedAt).toEqual(expect.any(Number))
		})
	})

	describe('createStoreScope', () => {
		const scopeFactory = () => createStore({ initialState: initialState() })

		const wrapperFor =
			(
				Provider: (props: {
					state?: Partial<TestState>
					children?: ReactNode
				}) => ReactElement,
				state?: Partial<TestState>,
			) =>
			({ children }: { children: ReactNode }) =>
				createElement(Provider, state === undefined ? { children } : { state, children })

		it('provides the store created by the factory', () => {
			const { Provider, useScopedStore } = createStoreScope(scopeFactory)
			const { result } = renderHook(() => useScopedStore(), {
				wrapper: wrapperFor(Provider),
			})

			expect(result.current.getState()).toEqual({ count: 0, name: 'test' })
		})

		it('throws when the hook is used outside the provider', () => {
			const { useScopedStore } = createStoreScope(scopeFactory, 'User')
			const onError = vi.spyOn(console, 'error').mockImplementation(() => {})

			expect(() => renderHook(() => useScopedStore())).toThrow(/User scope was read outside/)

			onError.mockRestore()
		})

		// The reason the scope exists: a module-level store would hand the
		// same state to every concurrent render on a server.
		it('creates an independent store per provider', () => {
			const { Provider, useScopedStore } = createStoreScope(scopeFactory)

			const first = renderHook(() => useScopedStore(), { wrapper: wrapperFor(Provider) })
			const second = renderHook(() => useScopedStore(), { wrapper: wrapperFor(Provider) })

			expect(first.result.current).not.toBe(second.result.current)

			act(() => {
				first.result.current.set({ count: 42 })
			})

			expect(first.result.current.getState().count).toBe(42)
			expect(second.result.current.getState().count).toBe(0)
		})

		it('seeds the store before the first render', () => {
			const { Provider, useScopedStore } = createStoreScope(scopeFactory)
			const seen: number[] = []

			renderHook(
				() => {
					const store = useScopedStore()
					seen.push(store.getState().count)

					return store
				},
				{ wrapper: wrapperFor(Provider, { count: 7 }) },
			)

			expect(seen[0]).toBe(7)
		})

		it('re-seeds when the state prop changes by value', () => {
			const { Provider, useScopedStore } = createStoreScope(scopeFactory)
			let seed: Partial<TestState> = { count: 1 }

			const { result, rerender } = renderHook(() => useScopedStore(), {
				wrapper: ({ children }: { children: ReactNode }) =>
					createElement(Provider, { state: seed, children }),
			})

			expect(result.current.getState().count).toBe(1)

			seed = { count: 9 }
			rerender()

			expect(result.current.getState().count).toBe(9)
		})

		// A parent re-render usually rebuilds the prop object. Re-seeding on
		// identity alone would revert anything the app wrote in between.
		it('does not clobber local writes when an equal seed is rebuilt', () => {
			const { Provider, useScopedStore } = createStoreScope(scopeFactory)
			const { result, rerender } = renderHook(() => useScopedStore(), {
				wrapper: ({ children }: { children: ReactNode }) =>
					createElement(Provider, { state: { count: 1 }, children }),
			})

			act(() => {
				result.current.set({ count: 5 })
			})
			rerender()

			expect(result.current.getState().count).toBe(5)
		})

		it('leaves the store untouched when no state is given', () => {
			const { Provider, useScopedStore } = createStoreScope(scopeFactory)
			const { result } = renderHook(() => useScopedStore(), {
				wrapper: wrapperFor(Provider),
			})

			expect(result.current.getState()).toEqual(initialState())
		})

		it('destroys its store on unmount', async () => {
			const created: ReturnType<typeof scopeFactory>[] = []
			const { Provider, useScopedStore } = createStoreScope(() => {
				const store = scopeFactory()
				created.push(store)

				return store
			})
			const onDestroy = vi.fn()

			const { unmount } = renderHook(
				() => {
					const store = useScopedStore()
					store.with({ name: 'spy', onDestroy })

					return store
				},
				{ wrapper: wrapperFor(Provider) },
			)

			unmount()
			await flushMicrotasks()

			expect(onDestroy).toHaveBeenCalledTimes(1)
			expect(() => created[0]?.getState()).toThrow('destroyed')
		})

		it('keeps a live store through StrictMode remounts, and destroys it on unmount', async () => {
			const { Provider, useScopedStore } = createStoreScope(scopeFactory)

			const { result, unmount } = renderHook(() => useScopedStore(), {
				wrapper: ({ children }: { children: ReactNode }) =>
					createElement(StrictMode, null, createElement(Provider, null, children)),
			})

			const store = result.current

			expect(() => store.getState()).not.toThrow()

			act(() => {
				store.set({ count: 3 })
			})
			expect(store.getState().count).toBe(3)

			unmount()
			await flushMicrotasks()

			expect(() => store.getState()).toThrow('destroyed')
		})
	})

	describe('createStoreScope with a child that subscribes', () => {
		const makeScope = () => {
			const created: ReturnType<typeof scopeFactoryWithPlugins>[] = []
			const used: ReturnType<typeof scopeFactoryWithPlugins>[] = []
			const scope = createStoreScope(() => {
				const store = scopeFactoryWithPlugins()
				created.push(store)

				return store
			})

			function Child() {
				const store = scope.useScopedStore()
				used.push(store)
				const count = useStore(store, state => state.count)

				return createElement(
					'button',
					{ onClick: () => store.set({ count: count + 1 }) },
					`count:${count}`,
				)
			}

			return { scope, Child, created, used }
		}

		const scopeFactoryWithPlugins = () =>
			createStore({ initialState: initialState() }).with(history<TestState>())

		it('renders and updates under StrictMode, and destroys the store on unmount', async () => {
			const { scope, Child, created, used } = makeScope()

			const { unmount } = render(
				createElement(
					StrictMode,
					null,
					createElement(scope.Provider, null, createElement(Child)),
				),
			)

			expect(screen.getByRole('button').textContent).toBe('count:0')

			act(() => {
				screen.getByRole('button').click()
			})
			expect(screen.getByRole('button').textContent).toBe('count:1')

			// StrictMode builds two in its double render. A third would mean the remount threw one away
			expect(created).toHaveLength(2)

			const inUse = used[used.length - 1] as ReturnType<typeof scopeFactoryWithPlugins>
			expect(() => inUse.getState()).not.toThrow()

			unmount()
			await flushMicrotasks()

			expect(() => inUse.getState()).toThrow('destroyed')
		})

		it('works under StrictMode with persist and sync in the factory', () => {
			const storage = createMemoryStorage()
			const transport = {
				send: () => {},
				onMessage: () => {},
				destroy: vi.fn(),
			}
			const scope = createStoreScope(() =>
				createStore({ initialState: initialState() })
					.with(persist<TestState>({ key: 'scope-test', storage }))
					.with(sync<TestState>({ channel: 'scope-test', transport })),
			)

			function Child() {
				const store = scope.useScopedStore()
				const count = useStore(store, state => state.count)

				return createElement('span', null, `count:${count}`)
			}

			const { unmount } = render(
				createElement(
					StrictMode,
					null,
					createElement(scope.Provider, null, createElement(Child)),
				),
			)

			expect(screen.getByText('count:0')).toBeTruthy()

			unmount()
		})

		it('survives an Activity boundary being hidden and shown again', async () => {
			const { scope, Child } = makeScope()
			const Page = ({ mode }: { mode: 'visible' | 'hidden' }) =>
				createElement(
					scope.Provider,
					null,
					createElement(Activity, { mode, children: createElement(Child) }),
				)

			const { rerender } = render(createElement(Page, { mode: 'visible' }))
			expect(screen.getByRole('button').textContent).toBe('count:0')

			rerender(createElement(Page, { mode: 'hidden' }))
			await flushMicrotasks()

			expect(() => rerender(createElement(Page, { mode: 'visible' }))).not.toThrow()
			await flushMicrotasks()

			act(() => {
				screen.getByRole('button').click()
			})

			expect(screen.getByRole('button').textContent).toBe('count:1')
		})

		it('keeps the state of a hidden Provider when it is shown again', async () => {
			const { scope, Child } = makeScope()
			const Page = ({ mode }: { mode: 'visible' | 'hidden' }) =>
				createElement(Activity, {
					mode,
					children: createElement(scope.Provider, null, createElement(Child)),
				})

			const { rerender } = render(createElement(Page, { mode: 'visible' }))

			act(() => {
				screen.getByRole('button').click()
			})
			act(() => {
				screen.getByRole('button').click()
			})
			act(() => {
				screen.getByRole('button').click()
			})
			expect(screen.getByRole('button').textContent).toBe('count:3')

			rerender(createElement(Page, { mode: 'hidden' }))
			await flushMicrotasks()
			rerender(createElement(Page, { mode: 'visible' }))
			await flushMicrotasks()

			expect(screen.getByRole('button').textContent).toBe('count:3')

			act(() => {
				screen.getByRole('button').click()
			})
			expect(screen.getByRole('button').textContent).toBe('count:4')
		})

		it('does not make the restored state an undo step', async () => {
			const { scope, Child, used } = makeScope()
			const Page = ({ mode }: { mode: 'visible' | 'hidden' }) =>
				createElement(Activity, {
					mode,
					children: createElement(scope.Provider, null, createElement(Child)),
				})

			const { rerender } = render(createElement(Page, { mode: 'visible' }))
			act(() => {
				screen.getByRole('button').click()
			})

			rerender(createElement(Page, { mode: 'hidden' }))
			await flushMicrotasks()
			rerender(createElement(Page, { mode: 'visible' }))
			await flushMicrotasks()

			const store = used[used.length - 1] as ReturnType<typeof scopeFactoryWithPlugins>
			expect(store.getState().count).toBe(1)
			expect(store.canUndo()).toBe(false)
		})

		it('keeps persist and sync in the factory to one live copy, and does not write stale state', async () => {
			const storage = createMemoryStorage()
			const channels: { sent: unknown[]; destroyed: boolean }[] = []
			const scope = createStoreScope(() => {
				const channel = { sent: [] as unknown[], destroyed: false }
				channels.push(channel)

				return createStore({ initialState: initialState() })
					.with(persist<TestState>({ key: 'scope-keep', storage, debounceMs: 0 }))
					.with(
						sync<TestState>({
							channel: 'scope-keep',
							debounceMs: 0,
							transport: {
								send: message => {
									channel.sent.push(message)
								},
								onMessage: () => {},
								destroy: () => {
									channel.destroyed = true
								},
							},
						}),
					)
			})

			function Child() {
				const store = scope.useScopedStore()
				const count = useStore(store, state => state.count)

				return createElement(
					'button',
					{ onClick: () => store.set({ count: count + 1 }) },
					`count:${count}`,
				)
			}

			const Page = ({ mode }: { mode: 'visible' | 'hidden' }) =>
				createElement(Activity, {
					mode,
					children: createElement(scope.Provider, null, createElement(Child)),
				})

			const { rerender, unmount } = render(createElement(Page, { mode: 'visible' }))
			act(() => {
				screen.getByRole('button').click()
			})
			act(() => {
				screen.getByRole('button').click()
			})
			await new Promise(resolve => setTimeout(resolve, 10))

			rerender(createElement(Page, { mode: 'hidden' }))
			await flushMicrotasks()
			rerender(createElement(Page, { mode: 'visible' }))
			await new Promise(resolve => setTimeout(resolve, 10))

			expect(screen.getByRole('button').textContent).toBe('count:2')
			expect(JSON.parse(storage.store.get('scope-keep') as string).state.count).toBe(2)

			const alive = channels.filter(channel => !channel.destroyed)
			expect(alive).toHaveLength(1)

			// The new store asks peers for state, and never pushes its own seed as an edit
			const last = channels[channels.length - 1]
			expect(
				last?.sent.some(message => (message as { type: string }).type === 'patches'),
			).toBe(false)

			unmount()
			await flushMicrotasks()
			expect(channels.every(channel => channel.destroyed)).toBe(true)
		})

		it('keeps updating after the Provider itself is hidden and shown', async () => {
			const { scope, Child } = makeScope()
			const Page = ({ mode }: { mode: 'visible' | 'hidden' }) =>
				createElement(Activity, {
					mode,
					children: createElement(scope.Provider, null, createElement(Child)),
				})

			const { rerender } = render(createElement(Page, { mode: 'visible' }))

			rerender(createElement(Page, { mode: 'hidden' }))
			await flushMicrotasks()
			rerender(createElement(Page, { mode: 'visible' }))
			await flushMicrotasks()

			act(() => {
				screen.getByRole('button').click()
			})

			expect(screen.getByRole('button').textContent).toBe('count:1')
		})
	})

	describe('useAutosave callbacks', () => {
		it('save and load resolve with whether they worked, and never reject into a handler', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({
					save: () => {
						throw new Error('server down')
					},
					load: () => {
						throw new Error('offline')
					},
				}),
			)
			const { result } = renderHook(() => useAutosave(store))

			act(() => {
				store.set({ count: 1 })
			})

			await act(async () => {
				await expect(result.current.save()).resolves.toBe(false)
				await expect(result.current.load()).resolves.toBe(false)
			})

			expect(result.current.status).toBe('error')
		})

		it('save resolves true when it worked', async () => {
			const store = createStore({ initialState: initialState() }).with(
				autosave<TestState>({ save: () => {} }),
			)
			const { result } = renderHook(() => useAutosave(store))

			act(() => {
				store.set({ count: 1 })
			})

			await act(async () => {
				await expect(result.current.save()).resolves.toBe(true)
			})
		})
	})
})
