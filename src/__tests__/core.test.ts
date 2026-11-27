import { describe, it, expect, vi } from 'vitest'
import { createStore, shallowEqual, type Plugin, type PluginContext } from '../core'
import { StoreError } from '../error'
import { history } from '../plugins/history'
import { immer } from '../immer'

interface TestState {
	count: number
	name: string
}

const initialState = (): TestState => ({ count: 0, name: 'test' })

describe('core Store', () => {
	it('mutates state and notifies subscribers', () => {
		const store = createStore({ initialState: initialState() }).with(immer())
		const listener = vi.fn()
		store.subscribe(listener)

		store.mutate(draft => {
			draft.count = 1
		})

		expect(store.getState().count).toBe(1)
		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))
	})

	it('skips commit entirely when recipe produces no patches', () => {
		const store = createStore({ initialState: initialState() }).with(immer())
		const listener = vi.fn()
		const onCommit = vi.fn()
		store.subscribe(listener)
		store.with({ name: 'spy', onCommit })

		store.mutate(() => {})

		expect(listener).not.toHaveBeenCalled()
		expect(onCommit).not.toHaveBeenCalled()
	})

	it('commits several changes from one recipe as a single commit', () => {
		const store = createStore({ initialState: initialState() }).with(immer())
		const onCommit = vi.fn()
		store.with({ name: 'spy', onCommit })

		store.mutate(draft => {
			draft.count = 1
			draft.name = 'batched'
		}, 'one recipe')

		expect(store.getState()).toEqual({ count: 1, name: 'batched' })
		expect(onCommit).toHaveBeenCalledTimes(1)
		expect(onCommit.mock.calls[0]?.[0]).toMatchObject({ description: 'one recipe' })
		expect(onCommit.mock.calls[0]?.[0].patches.length).toBe(2)
	})

	it('undoes an immer recipe as one step', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(history<TestState>())
		store.mutate(draft => {
			draft.count = 3
		}, 'set count')

		expect(store.getState().count).toBe(3)
		expect(store.undo()).toBe(true)
		expect(store.getState().count).toBe(0)
	})

	it('rejects an invalid initial state', () => {
		expect(() =>
			createStore({ initialState: null as unknown as TestState }).with(immer()),
		).toThrow(StoreError)
	})

	describe('plugin installation', () => {
		it('throws on duplicate plugin names', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			store.with({ name: 'dup' })

			expect(() => store.with({ name: 'dup' })).toThrow('already installed')
		})

		it('throws when an extension key collides with an existing member', () => {
			const store = createStore({ initialState: initialState() }).with(immer())

			expect(() =>
				store.with({
					name: 'bad',
					onInit: () => ({ set: () => {} }),
				}),
			).toThrow('collides')
		})

		it('merges extensions onto the store with accumulated typing', () => {
			const store = createStore({ initialState: initialState() })
				.with(immer())
				.with(history<TestState>())

			// Calling undo() here doubles as the compile-time check that .with() carried the type
			store.mutate(draft => {
				draft.count = 5
			})
			expect(store.canUndo()).toBe(true)
			expect(store.undo()).toBe(true)
			expect(store.getState().count).toBe(0)
		})
	})

	describe('commit hooks', () => {
		it('vetoes the commit when onBeforeCommit throws', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const listener = vi.fn()
			const onCommit = vi.fn()
			store.subscribe(listener)
			store.with({
				name: 'validator',
				onBeforeCommit: payload => {
					if (payload.state.count < 0) {
						throw new StoreError('count must be >= 0', 'VALIDATION_FAILED')
					}
				},
				onCommit,
			})

			expect(() =>
				store.mutate(draft => {
					draft.count = -1
				}),
			).toThrow('count must be >= 0')

			expect(store.getState().count).toBe(0)
			expect(listener).not.toHaveBeenCalled()
			expect(onCommit).not.toHaveBeenCalled()
		})

		it('isolates onCommit failures and routes them to onError hooks', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const onError = vi.fn()
			const lateCommit = vi.fn()
			store.with({
				name: 'broken',
				onCommit: () => {
					throw new Error('plugin exploded')
				},
			})
			store.with({ name: 'late', onCommit: lateCommit })
			store.with({ name: 'errors', onError })

			store.mutate(draft => {
				draft.count = 1
			})

			expect(store.getState().count).toBe(1)
			expect(lateCommit).toHaveBeenCalledTimes(1)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'plugin exploded' }),
				'plugin:broken:onCommit',
			)
		})
	})

	describe('external state', () => {
		it('fans out onExternalState to every plugin except the source', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const sourceHook = vi.fn()
			const otherHook = vi.fn()
			let capturedCtx!: PluginContext<TestState>

			store.with({
				name: 'sync',
				onInit: ctx => {
					capturedCtx = ctx
				},
				onExternalState: sourceHook,
			})
			store.with({ name: 'observer', onExternalState: otherHook })

			capturedCtx.replaceState({ count: 99, name: 'remote' }, { source: 'sync' })

			expect(store.getState()).toEqual({ count: 99, name: 'remote' })
			expect(sourceHook).not.toHaveBeenCalled()
			expect(otherHook).toHaveBeenCalledWith(
				expect.objectContaining({ count: 99 }),
				expect.objectContaining({ source: 'sync' }),
			)
		})
	})

	describe('replaceState', () => {
		it('swaps state in place, notifying subscribers and external-state plugins', () => {
			const onExternalState = vi.fn()
			const store = createStore({ initialState: initialState() }).with(immer()).with({
				name: 'sync',
				onExternalState,
			})
			const listener = vi.fn()
			store.subscribe(listener)

			store.replaceState({ count: 9, name: 'migrated' })

			expect(store.getState()).toEqual({ count: 9, name: 'migrated' })
			expect(listener).toHaveBeenCalledWith({ count: 9, name: 'migrated' })
			expect(onExternalState).toHaveBeenCalledWith(
				{ count: 9, name: 'migrated' },
				expect.objectContaining({ source: 'replace' }),
			)
		})
	})

	describe('reset', () => {
		it('returns to the initial state and notifies listeners', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const listener = vi.fn()
			store.subscribe(listener)

			store.mutate(draft => {
				draft.count = 5
			})
			store.reset()

			expect(store.getState()).toEqual(initialState())
			expect(listener).toHaveBeenLastCalledWith(initialState())
			expect(store.getInitialState()).toEqual(initialState())
		})

		it('clears history through the full-replace rule', () => {
			const store = createStore({ initialState: initialState() })
				.with(immer())
				.with(history<TestState>())

			store.mutate(draft => {
				draft.count = 5
			})
			expect(store.canUndo()).toBe(true)

			store.reset()

			expect(store.canUndo()).toBe(false)
		})
	})

	describe('destroy', () => {
		it('calls onDestroy in reverse install order with the final state', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const order: string[] = []
			store.with({ name: 'first', onDestroy: () => order.push('first') })
			store.with({
				name: 'second',
				onDestroy: state => {
					order.push(`second:${state.count}`)
				},
			})

			store.mutate(draft => {
				draft.count = 7
			})
			store.destroy()

			expect(order).toEqual(['second:7', 'first'])
			expect(() => store.getState()).toThrow('destroyed')
			expect(() => store.with({ name: 'late' })).toThrow('destroyed')
		})
	})

	describe('set', () => {
		it('shallow-merges and notifies', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const listener = vi.fn()
			store.subscribe(listener)

			store.set({ count: 5, name: 'merged' })

			expect(store.getState()).toEqual({ count: 5, name: 'merged' })
			expect(listener).toHaveBeenCalledTimes(1)
		})

		it('is a no-op when nothing changed', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const listener = vi.fn()
			store.subscribe(listener)

			store.set({ count: 0, name: 'test' })
			expect(listener).not.toHaveBeenCalled()
		})

		it('commits per-key patches that history can undo', () => {
			const store = createStore({ initialState: initialState() })
				.with(immer())
				.with(history<TestState>())

			store.set({ count: 1 })
			store.set({ count: 2, name: 'later' })

			expect(store.undo()).toBe(true)
			expect(store.getState()).toEqual({ count: 1, name: 'test' })
			expect(store.undo()).toBe(true)
			expect(store.getState()).toEqual(initialState())
			expect(store.redo()).toBe(true)
			expect(store.getState().count).toBe(1)
		})

		it('freezes the result like mutate does', () => {
			const store = createStore({ initialState: { items: [] as number[] } }).with(immer())
			store.set({ items: [1, 2] })

			expect(Object.isFrozen(store.getState())).toBe(true)
			expect(Object.isFrozen(store.getState().items)).toBe(true)
		})

		it('rejects a non-object partial', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			expect(() => store.set(null as never)).toThrow('Partial state must be an object')
		})
	})

	describe('selector subscriptions', () => {
		it('fires only when the selected value changes, with the previous value', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const listener = vi.fn()
			store.subscribe(state => state.count, listener)

			store.set({ name: 'other' })
			expect(listener).not.toHaveBeenCalled()

			store.set({ count: 2 })
			expect(listener).toHaveBeenCalledTimes(1)
			expect(listener).toHaveBeenCalledWith(2, 0)
		})

		it('respects a custom equality function', () => {
			const store = createStore({ initialState: { items: [] as number[] } }).with(immer())
			const listener = vi.fn()
			store.subscribe(
				state => state.items,
				listener,
				(a, b) => a.length === b.length,
			)

			store.mutate(draft => {
				draft.items = [9]
			})
			expect(listener).toHaveBeenCalledTimes(1)

			store.mutate(draft => {
				draft.items = [8]
			})
			expect(listener).toHaveBeenCalledTimes(1)
		})

		it('stops firing after unsubscribe', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const listener = vi.fn()
			const unsubscribe = store.subscribe(state => state.count, listener)

			unsubscribe()
			store.set({ count: 9 })
			expect(listener).not.toHaveBeenCalled()
		})
	})

	describe('without plugins', () => {
		it('still commits and notifies', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const listener = vi.fn()
			store.subscribe(listener)

			store.mutate(draft => {
				draft.count++
			})
			expect(store.getState().count).toBe(1)
			expect(listener).toHaveBeenCalledTimes(1)
		})

		it('skips notification when a recipe changes nothing', () => {
			const store = createStore({ initialState: initialState() }).with(immer())
			const listener = vi.fn()
			store.subscribe(listener)

			store.mutate(() => {})
			expect(listener).not.toHaveBeenCalled()
		})
	})

	describe('initial state', () => {
		it('freezes the passed object so reset cannot be corrupted', () => {
			const passed = initialState()
			const store = createStore({ initialState: passed }).with(immer())

			expect(Object.isFrozen(passed)).toBe(true)
			store.set({ count: 9 })
			store.reset()
			expect(store.getState().count).toBe(0)
		})
	})
})

describe('plugins/history', () => {
	const setup = (maxSize?: number) =>
		createStore({ initialState: initialState() })
			.with(immer())
			.with(history<TestState>(maxSize === undefined ? {} : { maxSize }))

	it('undoes and redoes through patch history', () => {
		const store = setup()

		store.mutate(draft => {
			draft.count = 1
		}, 'one')
		store.mutate(draft => {
			draft.count = 2
		}, 'two')

		expect(store.undo()).toBe(true)
		expect(store.getState().count).toBe(1)
		expect(store.undo()).toBe(true)
		expect(store.getState().count).toBe(0)
		expect(store.undo()).toBe(false)

		expect(store.redo()).toBe(true)
		expect(store.getState().count).toBe(1)
		expect(store.redo()).toBe(true)
		expect(store.getState().count).toBe(2)
		expect(store.redo()).toBe(false)
	})

	it('does not record its own undo/redo as new history entries', () => {
		const store = setup()

		store.mutate(draft => {
			draft.count = 1
		})
		store.undo()
		store.redo()

		expect(store.getHistoryInfo().length).toBe(1)
	})

	it('truncates the redo branch when mutating after undo', () => {
		const store = setup()

		store.mutate(draft => {
			draft.count = 1
		})
		store.mutate(draft => {
			draft.count = 2
		})
		store.undo()
		store.mutate(draft => {
			draft.count = 10
		})

		expect(store.canRedo()).toBe(false)
		expect(store.getHistoryInfo().length).toBe(2)
		store.undo()
		expect(store.getState().count).toBe(1)
	})

	it('caps history at maxSize', () => {
		const store = setup(2)

		store.mutate(draft => {
			draft.count = 1
		})
		store.mutate(draft => {
			draft.count = 2
		})
		store.mutate(draft => {
			draft.count = 3
		})

		expect(store.getHistoryInfo().length).toBe(2)
		expect(store.undo()).toBe(true)
		expect(store.undo()).toBe(true)
		expect(store.undo()).toBe(false)
		expect(store.getState().count).toBe(1)
	})

	it('keeps getHistoryInfo referentially stable between history changes', () => {
		const store = setup()

		store.mutate(draft => {
			draft.count = 1
		}, 'first')

		const info = store.getHistoryInfo()
		expect(store.getHistoryInfo()).toBe(info)
		expect(info).toMatchObject({ canUndo: true, canRedo: false, lastDescription: 'first' })

		store.undo()
		expect(store.getHistoryInfo()).not.toBe(info)
	})

	it('clears history on a full-state external replacement', () => {
		const store = createStore({ initialState: initialState() }).with(immer())
		let capturedCtx!: PluginContext<TestState>
		const ctxCapture: Plugin<TestState> = {
			name: 'devtools',
			onInit: ctx => {
				capturedCtx = ctx
			},
		}
		const withHistory = store.with(ctxCapture).with(history<TestState>())

		withHistory.mutate(draft => {
			draft.count = 1
		})
		expect(withHistory.canUndo()).toBe(true)

		capturedCtx.replaceState({ count: 42, name: 'time-travel' }, { source: 'devtools' })

		expect(withHistory.getState().count).toBe(42)
		expect(withHistory.canUndo()).toBe(false)
		expect(withHistory.getHistoryInfo().length).toBe(0)
	})

	it('keeps history through patch-based external updates', () => {
		const store = createStore({ initialState: initialState() }).with(immer())
		let capturedCtx!: PluginContext<TestState>
		const withHistory = store
			.with({
				name: 'sync',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(history<TestState>())

		withHistory.mutate(draft => {
			draft.count = 1
		})

		capturedCtx.applyPatches([{ op: 'replace', path: ['name'], value: 'remote' }], {
			source: 'sync',
		})

		expect(withHistory.getState().name).toBe('remote')
		expect(withHistory.canUndo()).toBe(true)
	})

	it('rejects a non-positive maxSize', () => {
		expect(() => history({ maxSize: 0 })).toThrow('positive')
	})
})

describe('set with a function', () => {
	it('computes the update from the current state', () => {
		const store = createStore({ initialState: initialState() })

		store.set(state => ({ count: state.count + 1 }))
		store.set(state => ({ count: state.count + 1 }))

		expect(store.getState().count).toBe(2)
	})

	it('commits the keys that changed as top-level patches with inverses', () => {
		const store = createStore({ initialState: initialState() })
		const onCommit = vi.fn()
		store.with({ name: 'spy', onCommit })

		store.set({ count: 3, name: 'test' }, 'change')

		expect(onCommit.mock.calls[0]?.[0]).toMatchObject({
			description: 'change',
			patches: [{ op: 'replace', path: ['count'], value: 3 }],
			inversePatches: [{ op: 'replace', path: ['count'], value: 0 }],
		})
		expect(onCommit.mock.calls[0]?.[0]).not.toHaveProperty('operation')
	})

	it('treats an inherited property name as a new key, so undo removes it', () => {
		const store = createStore({ initialState: initialState() }).with(history<TestState>())

		store.set({ toString: 'x' } as unknown as Partial<TestState>)
		expect(Object.hasOwn(store.getState(), 'toString')).toBe(true)

		store.undo()

		expect(Object.hasOwn(store.getState(), 'toString')).toBe(false)
		expect(typeof store.getState().toString).toBe('function')
	})
})

describe('ctx.commit', () => {
	const capture = () => {
		let ctx!: PluginContext<TestState>
		const store = createStore({ initialState: initialState() }).with({
			name: 'capture',
			onInit: context => {
				ctx = context
			},
		})

		return { store, ctx: () => ctx }
	}

	it('commits a new state, diffing the top-level keys when no patches are given', () => {
		const { store, ctx } = capture()
		const onCommit = vi.fn()
		store.with({ name: 'spy', onCommit })

		ctx().commit({ count: 4, name: 'test' })

		expect(store.getState().count).toBe(4)
		expect(onCommit.mock.calls[0]?.[0].patches).toEqual([
			{ op: 'replace', path: ['count'], value: 4 },
		])
	})

	it('passes along patches it was given, and runs veto hooks first', () => {
		const { store, ctx } = capture()
		store.with({
			name: 'veto',
			onBeforeCommit: () => {
				throw new StoreError('no', 'VALIDATION_FAILED')
			},
		})

		expect(() =>
			ctx().commit(
				{ count: 4, name: 'test' },
				{ patches: [{ op: 'replace', path: ['count'], value: 4 }] },
			),
		).toThrow('no')
		expect(store.getState().count).toBe(0)
	})

	it('is a no-op when the state did not change', () => {
		const { store, ctx } = capture()
		const listener = vi.fn()
		store.subscribe(listener)

		ctx().commit(store.getState())

		expect(listener).not.toHaveBeenCalled()
	})

	it('freezes what it commits', () => {
		const { store, ctx } = capture()
		const next = { count: 1, name: 'x', extra: { deep: [1] } }

		ctx().commit(next)

		expect(Object.isFrozen(store.getState())).toBe(true)
		expect(Object.isFrozen(next.extra.deep)).toBe(true)
	})

	it('rejects a state that is not an object', () => {
		const { ctx } = capture()

		expect(() => ctx().commit(undefined as never)).toThrow('State must be an object')
	})
})

describe('state validity', () => {
	it.each([[undefined], [null], [[1, 2]], ['text'], [5]])(
		'replaceState rejects %j and leaves the state alone',
		value => {
			const store = createStore({ initialState: initialState() })
			const listener = vi.fn()
			store.subscribe(listener)

			expect(() => store.replaceState(value as never)).toThrow('State must be an object')

			expect(store.getState()).toEqual(initialState())
			expect(listener).not.toHaveBeenCalled()
		},
	)

	it('rejects an array or primitive as the initial state', () => {
		expect(() => createStore({ initialState: [] as never })).toThrow('must be an object')
		expect(() => createStore({ initialState: 5 as never })).toThrow('must be an object')
	})

	it('freezes state that comes in through replaceState and patches', () => {
		const store = createStore({ initialState: { n: { y: 1 }, list: [1] } })

		store.replaceState({ n: { y: 2 }, list: [2] })
		expect(Object.isFrozen(store.getState().n)).toBe(true)
		expect(Object.isFrozen(store.getState().list)).toBe(true)

		let ctx!: PluginContext<{ n: { y: number }; list: number[] }>
		store.with({
			name: 'capture',
			onInit: context => {
				ctx = context
			},
		})
		ctx.applyPatches([{ op: 'add', path: ['list', 1], value: 3 }], { source: 'test' })

		expect(store.getState().list).toEqual([2, 3])
		expect(Object.isFrozen(store.getState().list)).toBe(true)
	})
})

describe('a failed plugin install', () => {
	it('leaves nothing registered when onInit throws, and cleans up after itself', () => {
		const store = createStore({ initialState: initialState() })
		const onCommit = vi.fn()
		const onDestroy = vi.fn()

		expect(() =>
			store.with({
				name: 'broken',
				onInit: () => {
					throw new Error('init failed')
				},
				onCommit,
				onDestroy,
			}),
		).toThrow('init failed')

		store.set({ count: 1 })

		expect(onCommit).not.toHaveBeenCalled()
		expect(onDestroy).toHaveBeenCalledTimes(1)
		expect(() => store.with({ name: 'broken' })).not.toThrow()
	})

	it('leaves nothing registered when an extension collides', () => {
		const store = createStore({ initialState: initialState() })
		const onCommit = vi.fn()

		expect(() =>
			store.with({ name: 'colliding', onInit: () => ({ set: () => {} }), onCommit }),
		).toThrow('collides')

		store.set({ count: 1 })

		expect(onCommit).not.toHaveBeenCalled()
		expect(() => store.with({ name: 'colliding' })).not.toThrow()
	})
})

describe('errors', () => {
	it('gives onError a StoreError with a code, whatever was thrown', () => {
		const store = createStore({ initialState: initialState() })
		const onError = vi.fn()
		store.with({
			name: 'broken',
			onCommit: () => {
				throw new Error('plain error')
			},
		})
		store.with({ name: 'errors', onError })

		store.set({ count: 1 })

		const error = onError.mock.calls[0]?.[0]
		expect(error).toBeInstanceOf(StoreError)
		expect(error.code).toBe('PLUGIN_FAILED')
		expect(error.cause).toBeInstanceOf(Error)
	})

	it('reports a throwing listener through onError and keeps notifying the rest', () => {
		const store = createStore({ initialState: initialState() })
		const onError = vi.fn()
		const later = vi.fn()
		store.with({ name: 'errors', onError })
		store.subscribe(() => {
			throw new Error('listener failed')
		})
		store.subscribe(later)

		store.set({ count: 1 })

		expect(later).toHaveBeenCalled()
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'PLUGIN_FAILED' }),
			'notify',
		)
	})

	it('falls back to the console only when no plugin handles errors', () => {
		const store = createStore({ initialState: initialState() })
		store.with({
			name: 'broken',
			onCommit: () => {
				throw new Error('nobody listens')
			},
		})

		store.set({ count: 1 })

		expect(console.error).toHaveBeenCalled()
	})

	it('uses DESTROYED and DUPLICATE_PLUGIN codes', () => {
		const store = createStore({ initialState: initialState() })
		store.with({ name: 'dup' })

		expect(() => store.with({ name: 'dup' })).toThrow(
			expect.objectContaining({ code: 'DUPLICATE_PLUGIN' }),
		)

		store.destroy()

		expect(() => store.getState()).toThrow(expect.objectContaining({ code: 'DESTROYED' }))
	})
})

describe('shallowEqual', () => {
	it('compares one level deep', () => {
		expect(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true)
		expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false)
		expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
		expect(shallowEqual({ a: { x: 1 } }, { a: { x: 1 } })).toBe(false)
		expect(shallowEqual([1, 2], [1, 2])).toBe(true)
		expect(shallowEqual([1, 2], [1, 3])).toBe(false)
	})

	it('handles primitives, null and key sets that only differ by name', () => {
		expect(shallowEqual(1, 1)).toBe(true)
		expect(shallowEqual(1, 2)).toBe(false)
		expect(shallowEqual(null, null)).toBe(true)
		expect(shallowEqual(null, {})).toBe(false)
		expect(shallowEqual({ a: undefined }, { b: undefined })).toBe(false)
		expect(shallowEqual([], {})).toBe(false)
		expect(shallowEqual(NaN, NaN)).toBe(true)
	})
})

describe('history limits', () => {
	it.each([[Number.NaN], [1.5], [-1], [Infinity]])('rejects maxSize %s', maxSize => {
		expect(() => history({ maxSize })).toThrow('positive integer')
	})
})

describe('shallowEqual with maps, sets and other objects', () => {
	it('compares Map entries', () => {
		expect(shallowEqual(new Map([[1, 2]]), new Map([[1, 2]]))).toBe(true)
		expect(shallowEqual(new Map([[1, 2]]), new Map([[3, 4]]))).toBe(false)
		expect(shallowEqual(new Map([[1, 2]]), new Map([[1, 3]]))).toBe(false)
		expect(shallowEqual(new Map([[1, 2]]), new Map())).toBe(false)
		expect(shallowEqual(new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]]))).toBe(false)
	})

	it('compares Set members', () => {
		expect(shallowEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true)
		expect(shallowEqual(new Set([1]), new Set([2]))).toBe(false)
		expect(shallowEqual(new Set([1]), new Set([1, 2]))).toBe(false)
	})

	it('does not mix a Map or Set with a plain object', () => {
		expect(shallowEqual<unknown>(new Map(), {})).toBe(false)
		expect(shallowEqual<unknown>({}, new Set())).toBe(false)
		expect(shallowEqual<unknown>(new Map(), new Set())).toBe(false)
	})

	describe('undo and redo failures', () => {
		it('say which one failed, and report it as a plugin failure with the cause', () => {
			interface ListState {
				list: number[]
				other: number
			}
			let ctx!: PluginContext<ListState>
			const onError = vi.fn()
			const store = createStore<ListState>({ initialState: { list: [1], other: 0 } })
				.with(immer())
				.with({
					name: 'capture',
					onInit: context => {
						ctx = context
					},
				})
				.with({ name: 'errors', onError })
				.with(history<ListState>())

			store.mutate(draft => {
				draft.list.push(2)
			})
			// The list is emptied behind history's back, while claiming to touch another key
			ctx.replaceState(
				{ list: [], other: 1 },
				{ source: 'other-plugin', patches: [{ op: 'replace', path: ['other'], value: 1 }] },
			)

			expect(store.undo()).toBe(false)
			expect(onError).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'PLUGIN_FAILED',
					message: expect.stringContaining('Undo failed'),
					cause: expect.objectContaining({ code: 'PATCH_CONFLICT' }),
				}),
				'undo',
			)
		})
	})
})
