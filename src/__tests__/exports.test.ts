import { describe, it, expect } from 'vitest'
import { createStore, validate, type StoreConfig, type StandardSchemaV1 } from '../index'

describe('Package Exports', () => {
	describe('Main entry', () => {
		it('exports the store factory, errors and helpers', async () => {
			const main = await import('../index')

			expect(main.createStore).toBeDefined()
			expect(main.StoreError).toBeDefined()
			expect(main.shallowEqual).toBeDefined()
			expect(main.sharedStore).toBeDefined()
		})

		it('exports the registry factory only, not the classes', async () => {
			const main = await import('../index')

			expect(main.createRegistry).toBeDefined()
			expect((main as Record<string, unknown>).Registry).toBeUndefined()
			expect((main as Record<string, unknown>).Store).toBeUndefined()
		})

		it('exports all plugins', async () => {
			const main = await import('../index')

			expect(main.history).toBeDefined()
			expect(main.persist).toBeDefined()
			expect(main.devtools).toBeDefined()
			expect(main.sync).toBeDefined()
			expect(main.validate).toBeDefined()
			expect(main.autosave).toBeDefined()
		})

		it('does not export the transport classes or immer', async () => {
			const main = await import('../index')

			expect((main as Record<string, unknown>).BroadcastChannelTransport).toBeUndefined()
			expect((main as Record<string, unknown>).immer).toBeUndefined()
		})

		it('exports core types', async () => {
			const _typeTest: StoreConfig<{ count: number }> = {
				initialState: { count: 0 },
			}

			expect(_typeTest).toBeDefined()
		})

		it('exports the schema type plugins accept', () => {
			const schema: StandardSchemaV1<{ count: number }> = {
				'~standard': {
					version: 1,
					vendor: 'test',
					validate: value => ({ value: value as { count: number } }),
				},
			}

			const store = createStore({ initialState: { count: 0 } }).with(validate(schema))

			expect(store.getState().count).toBe(0)
		})

		it('does NOT export React hooks from the main entry', async () => {
			const main = await import('../index')

			expect((main as Record<string, unknown>).useStore).toBeUndefined()
		})
	})

	describe('React entry', () => {
		it('exports exactly the hooks and the scope factory', async () => {
			const react = await import('../react')

			expect(Object.keys(react).sort()).toEqual([
				'createStoreScope',
				'useAutosave',
				'useHistory',
				'useHydration',
				'useRegistry',
				'useStore',
				'useSubscription',
			])
		})
	})

	describe('Immer entry', () => {
		it('exports the immer plugin', async () => {
			const entry = await import('../immer')

			expect(Object.keys(entry)).toEqual(['immer'])
		})
	})

	describe('Sync WS entry', () => {
		it('exports only WebSocketTransport', async () => {
			const syncWs = await import('../transports/websocket')

			expect(Object.keys(syncWs)).toEqual(['WebSocketTransport'])
		})
	})
})
