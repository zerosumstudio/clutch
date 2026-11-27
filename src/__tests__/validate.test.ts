import { describe, it, expect, vi } from 'vitest'
import { createStore, type PluginContext } from '../core'
import { StoreError } from '../error'
import type { StandardSchemaV1 } from '../plugins/standard-schema'
import { validate } from '../plugins/validate'
import { immer } from '../immer'

interface TestState {
	count: number
}

const initialState = (): TestState => ({ count: 0 })

function nonNegativeCountSchema(options: { async?: boolean } = {}): StandardSchemaV1<TestState> {
	return {
		'~standard': {
			version: 1,
			vendor: 'clutch-test',
			validate: value => {
				const state = value as TestState
				const result =
					typeof state?.count === 'number' && state.count >= 0
						? { value: state }
						: { issues: [{ message: 'count must be a non-negative number' }] }
				return options.async ? Promise.resolve(result) : result
			},
		},
	}
}

describe('plugins/validate', () => {
	it('requires a validator function', () => {
		expect(() => validate(null as unknown as () => boolean)).toThrow(StoreError)
	})

	it('vetoes commits that fail validation', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(validate<TestState>(state => state.count >= 0))
		const listener = vi.fn()
		store.subscribe(listener)

		expect(() =>
			store.mutate(draft => {
				draft.count = -1
			}),
		).toThrow('State validation failed')

		expect(store.getState().count).toBe(0)
		expect(listener).not.toHaveBeenCalled()
	})

	it('lets valid commits through', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(validate<TestState>(state => state.count >= 0))

		store.mutate(draft => {
			draft.count = 5
		})

		expect(store.getState().count).toBe(5)
	})

	it('vetoes an invalid set', () => {
		const store = createStore({ initialState: initialState() }).with(
			validate<TestState>(state => state.count >= 0),
		)

		expect(() => store.set(state => ({ count: state.count - 5 }))).toThrow(
			'State validation failed',
		)

		expect(store.getState().count).toBe(0)
	})

	it('reports invalid external states without reverting them', () => {
		const onError = vi.fn()
		let capturedCtx!: PluginContext<TestState>
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with({ name: 'errors', onError })
			.with({
				name: 'sync',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(validate<TestState>(state => state.count >= 0))

		capturedCtx.replaceState({ count: -7 }, { source: 'sync' })

		expect(store.getState().count).toBe(-7)
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'State validation failed for external update from "sync"',
			}),
			'validate',
		)
	})

	it('stays quiet for valid external states', () => {
		const onError = vi.fn()
		let capturedCtx!: PluginContext<TestState>
		createStore({ initialState: initialState() })
			.with(immer())
			.with({ name: 'errors', onError })
			.with({
				name: 'sync',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(validate<TestState>(state => state.count >= 0))

		capturedCtx.replaceState({ count: 7 }, { source: 'sync' })

		expect(onError).not.toHaveBeenCalled()
	})

	it('uses a returned string as the rejection message', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(
				validate<TestState>(state =>
					state.count >= 0 ? true : 'count must not go negative',
				),
			)

		expect(() =>
			store.mutate(draft => {
				draft.count = -1
			}),
		).toThrow('count must not go negative')
		expect(store.getState().count).toBe(0)
	})

	it('keeps the generic message for a plain false', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(validate<TestState>(state => state.count >= 0))

		expect(() =>
			store.mutate(draft => {
				draft.count = -1
			}),
		).toThrow('State validation failed')
	})

	/*
	 *   STANDARD SCHEMA
	 ***************************************************************************************************/
	it('accepts a Standard Schema and vetoes commits that violate it', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(validate(nonNegativeCountSchema()))

		expect(() =>
			store.mutate(draft => {
				draft.count = -1
			}),
		).toThrow('State validation failed: 1 issue at (root)')
		expect(store.getState().count).toBe(0)

		store.mutate(draft => {
			draft.count = 3
		})
		expect(store.getState().count).toBe(3)
	})

	it('reports schema failures on external state', () => {
		const onError = vi.fn()
		let capturedCtx!: PluginContext<TestState>
		createStore({ initialState: initialState() })
			.with(immer())
			.with({ name: 'errors', onError })
			.with({
				name: 'sync',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(validate(nonNegativeCountSchema()))

		capturedCtx.replaceState({ count: -7 }, { source: 'sync' })

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.stringContaining('1 issue at (root)'),
			}),
			'validate',
		)
	})

	it('keeps schema issue text out of the message and on the cause', () => {
		const store = createStore({ initialState: initialState() }).with(
			validate(nonNegativeCountSchema()),
		)

		let caught: unknown
		try {
			store.set({ count: -1 })
		} catch (error) {
			caught = error
		}

		expect((caught as Error).message).not.toContain('non-negative')
		expect((caught as Error).cause).toEqual([
			expect.objectContaining({ message: 'count must be a non-negative number' }),
		])
	})

	it('rejects an async schema, since commits are synchronous', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(validate(nonNegativeCountSchema({ async: true })))

		expect(() =>
			store.mutate(draft => {
				draft.count = 1
			}),
		).toThrow('Async schema validation is not supported')
	})

	it('rejects a validator that is neither a function nor a schema', () => {
		expect(() => validate({} as unknown as () => boolean)).toThrow(StoreError)
	})
})
