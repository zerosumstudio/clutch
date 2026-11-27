import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createStore, type PluginContext } from '../core'
import { devtools } from '../plugins/devtools'
import { history } from '../plugins/history'
import { immer } from '../immer'

interface TestState {
	count: number
	name: string
}

const initialState = (): TestState => ({ count: 0, name: 'test' })

type DispatchMessage = {
	type: string
	payload?: { type: string; [key: string]: unknown }
	state?: string
}

describe('plugins/devtools', () => {
	let mockConnection: {
		init: ReturnType<typeof vi.fn>
		send: ReturnType<typeof vi.fn>
		subscribe: ReturnType<typeof vi.fn>
		unsubscribe: ReturnType<typeof vi.fn>
	}
	let mockExtension: { connect: ReturnType<typeof vi.fn> }

	const dispatch = (message: DispatchMessage): void => {
		const subscribeCallback = mockConnection.subscribe.mock.calls[0]?.[0]
		subscribeCallback(message)
	}

	beforeEach(() => {
		mockConnection = {
			init: vi.fn(),
			send: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
			unsubscribe: vi.fn(),
		}
		mockExtension = {
			connect: vi.fn(() => mockConnection),
		}
		;(window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__ = mockExtension
	})

	afterEach(() => {
		delete (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__
	})

	it('connects and sends the initial state on install', () => {
		createStore({ initialState: initialState() })
			.with(immer())
			.with(devtools<TestState>({ name: 'TestApp', maxAge: 10 }))

		expect(mockExtension.connect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'TestApp', maxAge: 10 }),
		)
		expect(mockConnection.init).toHaveBeenCalledWith({ count: 0, name: 'test' })
	})

	it('sends commits with description and patch count', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(devtools<TestState>())

		store.mutate(draft => {
			draft.count = 1
		}, 'increment')

		expect(mockConnection.send).toHaveBeenCalledWith(
			{ type: 'increment', patches: 1 },
			expect.objectContaining({ count: 1 }),
			{},
			expect.any(String),
		)
	})

	it('labels a commit without a description as an update', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(devtools<TestState>())

		store.mutate(draft => {
			draft.count = 1
		})

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'update' }),
			expect.anything(),
			{},
			expect.any(String),
		)
	})

	it('sends external updates from other plugins, labeled by source', () => {
		let capturedCtx!: PluginContext<TestState>
		createStore({ initialState: initialState() })
			.with(immer())
			.with({
				name: 'sync',
				onInit: (ctx: PluginContext<TestState>) => {
					capturedCtx = ctx
				},
			})
			.with(devtools<TestState>())

		capturedCtx.replaceState({ count: 9, name: 'remote' }, { source: 'sync' })

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'external:sync' }),
			expect.objectContaining({ count: 9 }),
			{},
			expect.any(String),
		)
	})

	it('shows undo operations coming from the history plugin', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(devtools<TestState>())
			.with(history<TestState>())

		store.mutate(draft => {
			draft.count = 1
		}, 'increment')
		mockConnection.send.mockClear()

		store.undo()

		expect(mockConnection.send).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'increment' }),
			expect.objectContaining({ count: 0 }),
			{},
			expect.any(String),
		)
	})

	describe('time travel', () => {
		it('applies JUMP_TO_STATE via replaceState and clears history', () => {
			const store = createStore({ initialState: initialState() })
				.with(immer())
				.with(devtools<TestState>())
				.with(history<TestState>())

			store.mutate(draft => {
				draft.count = 1
			})
			expect(store.canUndo()).toBe(true)
			mockConnection.send.mockClear()

			dispatch({
				type: 'DISPATCH',
				payload: { type: 'JUMP_TO_STATE' },
				state: JSON.stringify({ count: 77, name: 'jumped' }),
			})

			expect(store.getState()).toEqual({ count: 77, name: 'jumped' })
			expect(store.canUndo()).toBe(false)
			// Our own time travel must not echo back to the extension
			expect(mockConnection.send).not.toHaveBeenCalled()
		})

		it('applies the last computed state from IMPORT_STATE', () => {
			const store = createStore({ initialState: initialState() })
				.with(immer())
				.with(devtools<TestState>())

			dispatch({
				type: 'DISPATCH',
				payload: {
					type: 'IMPORT_STATE',
					nextLiftedState: {
						computedStates: [
							{ state: { count: 1, name: 'test' } },
							{ state: { count: 2, name: 'test' } },
							{ state: { count: 3, name: 'imported' } },
						],
					},
				},
			})

			expect(store.getState()).toEqual({ count: 3, name: 'imported' })
		})

		it('rejects prototype pollution in time-travel payloads', () => {
			const store = createStore({ initialState: initialState() })
				.with(immer())
				.with(devtools<TestState>())

			dispatch({
				type: 'DISPATCH',
				payload: { type: 'JUMP_TO_STATE' },
				state: `{"count":5,"__proto__":{"polluted":true}}`,
			})

			expect(({} as Record<string, unknown>).polluted).toBeUndefined()
			expect(Object.prototype.hasOwnProperty.call(store.getState(), '__proto__')).toBe(false)
		})
	})

	it('accepts imported state that holds the word constructor as data', () => {
		const store = createStore({ initialState: initialState() }).with(devtools<TestState>())

		dispatch({
			type: 'DISPATCH',
			payload: {
				type: 'IMPORT_STATE',
				nextLiftedState: { computedStates: [{ state: { count: 1, name: 'constructor' } }] },
			},
		})

		expect(store.getState()).toEqual({ count: 1, name: 'constructor' })
	})

	it('reports a failing send through onError instead of breaking the commit', () => {
		const onError = vi.fn()
		const store = createStore({ initialState: initialState() })
			.with({ name: 'errors', onError })
			.with(devtools<TestState>())
		mockConnection.send.mockImplementation(() => {
			throw new Error('extension gone')
		})

		store.set({ count: 1 })

		expect(store.getState().count).toBe(1)
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'DEVTOOLS_FAILED' }),
			'devtools',
		)
	})

	it('reports a failed connect through onError', () => {
		const onError = vi.fn()
		mockExtension.connect.mockImplementation(() => {
			throw new Error('no port')
		})

		createStore({ initialState: initialState() })
			.with({ name: 'errors', onError })
			.with(devtools<TestState>())

		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'DEVTOOLS_FAILED' }),
			'devtools',
		)
	})

	it('reports a rejected time-travel payload', () => {
		const onError = vi.fn()
		const store = createStore({ initialState: initialState() })
			.with({ name: 'errors', onError })
			.with(devtools<TestState>())

		dispatch({ type: 'DISPATCH', payload: { type: 'JUMP_TO_STATE' }, state: '[1,2]' })

		expect(store.getState()).toEqual(initialState())
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ code: 'DEVTOOLS_FAILED' }),
			'devtools',
		)
	})

	it('disconnects on destroy', () => {
		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(devtools<TestState>())

		const unsubscribe = mockConnection.subscribe.mock.results[0]?.value
		store.destroy()

		expect(unsubscribe).toHaveBeenCalled()
		expect(mockConnection.unsubscribe).toHaveBeenCalled()
	})

	it('stays inert when the extension is missing', () => {
		delete (window as unknown as Record<string, unknown>).__REDUX_DEVTOOLS_EXTENSION__

		const store = createStore({ initialState: initialState() })
			.with(immer())
			.with(devtools<TestState>())

		store.mutate(draft => {
			draft.count = 1
		})

		expect(store.getState().count).toBe(1)
		expect(mockExtension.connect).not.toHaveBeenCalled()
	})

	it('stays inert in a non-browser environment', () => {
		vi.stubGlobal('window', undefined)

		try {
			const store = createStore({ initialState: initialState() })
				.with(immer())
				.with(devtools<TestState>())

			store.mutate(draft => {
				draft.count = 1
			})

			expect(store.getState().count).toBe(1)
			expect(mockExtension.connect).not.toHaveBeenCalled()
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
