import { describe, it, expect, vi } from 'vitest'
import { createStore } from '../core'
import { history } from '../plugins/history'
import { immer, type Draft } from '../immer'

interface TestState {
	count: number
	items: { id: number; label: string }[]
}

const initialState = (): TestState => ({ count: 0, items: [{ id: 1, label: 'a' }] })

describe('immer plugin', () => {
	it('adds mutate, with a typed draft', () => {
		const store = createStore({ initialState: initialState() }).with(immer())

		store.mutate(draft => {
			const typed: Draft<TestState> = draft
			typed.count += 1
			typed.items.push({ id: 2, label: 'b' })
		})

		expect(store.getState().count).toBe(1)
		expect(store.getState().items).toHaveLength(2)
	})

	it('leaves untouched parts of the state structurally shared', () => {
		const store = createStore({ initialState: initialState() }).with(immer())
		const before = store.getState()

		store.mutate(draft => {
			draft.count = 5
		})

		expect(store.getState().items).toBe(before.items)
	})

	it('commits nothing when the recipe changes nothing', () => {
		const store = createStore({ initialState: initialState() }).with(immer())
		const listener = vi.fn()
		const onCommit = vi.fn()
		store.subscribe(listener)
		store.with({ name: 'spy', onCommit })

		store.mutate(() => {})

		expect(listener).not.toHaveBeenCalled()
		expect(onCommit).not.toHaveBeenCalled()
	})

	it('commits deep patches and the description to other plugins', () => {
		const store = createStore({ initialState: initialState() }).with(immer())
		const onCommit = vi.fn()
		store.with({ name: 'spy', onCommit })

		store.mutate(draft => {
			draft.items[0]!.label = 'renamed'
		}, 'rename')

		expect(onCommit.mock.calls[0]?.[0]).toMatchObject({
			description: 'rename',
			patches: [{ op: 'replace', path: ['items', 0, 'label'], value: 'renamed' }],
			inversePatches: [{ op: 'replace', path: ['items', 0, 'label'], value: 'a' }],
		})
	})

	it('undoes and redoes a deep change through history', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(history<TestState>())

		store.mutate(draft => {
			draft.items[0]!.label = 'renamed'
			draft.items.push({ id: 2, label: 'b' })
		})

		store.undo()
		expect(store.getState()).toEqual(initialState())

		store.redo()
		expect(store.getState().items.map(item => item.label)).toEqual(['renamed', 'b'])
	})

	it('freezes the result and rejects a non-function recipe', () => {
		const store = createStore({ initialState: initialState() }).with(immer())

		store.mutate(draft => {
			draft.count = 1
		})

		expect(Object.isFrozen(store.getState().items)).toBe(true)
		expect(() => store.mutate(null as never)).toThrow('Recipe must be a function')
	})

	it('can run before any other plugin and after destroy it throws DESTROYED', () => {
		const store = createStore({ initialState: initialState() }).with(immer())

		store.destroy()

		expect(() => store.mutate(() => {})).toThrow('destroyed')
	})

	it('makes a draft vetoable like any other commit', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with({
				name: 'veto',
				onBeforeCommit: payload => {
					if (payload.state.count < 0) {
						throw new Error('negative')
					}
				},
			})

		expect(() =>
			store.mutate(draft => {
				draft.count = -1
			}),
		).toThrow('negative')
		expect(store.getState().count).toBe(0)
	})

	it('refuses an async recipe at compile time, and a returned state is still fine', () => {
		const store = createStore({ initialState: initialState() }).with(immer())

		const asyncRecipe = async (draft: Draft<TestState>): Promise<void> => {
			draft.count = 1
		}
		// @ts-expect-error an async recipe is revoked before it runs, so the change would be lost
		const attempt = (): void => store.mutate(asyncRecipe)
		expect(attempt).toBeTypeOf('function')

		store.mutate(() => ({ count: 7, items: [] }))

		expect(store.getState()).toEqual({ count: 7, items: [] })
	})
})
