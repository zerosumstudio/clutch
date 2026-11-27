import { describe, it, expect, vi } from 'vitest'
import { createStore } from '../core'
import { StoreError } from '../error'
import { createRegistry } from '../registry'
import { history } from '../plugins/history'
import { immer } from '../immer'

interface UserState {
	name: string
}

interface CartState {
	items: number
}

describe('registry', () => {
	describe('combined state', () => {
		it('combines member states under their keys', () => {
			const registry = createRegistry({
				user: createStore<UserState>({ initialState: { name: 'beni' } }).with(immer()),
				cart: createStore<CartState>({ initialState: { items: 0 } }).with(immer()),
			})

			expect(registry.getState()).toEqual({
				user: { name: 'beni' },
				cart: { items: 0 },
			})
		})

		it('keeps the combined snapshot referentially stable until a member changes', () => {
			const registry = createRegistry({
				user: createStore<UserState>({ initialState: { name: 'beni' } }).with(immer()),
			})

			const first = registry.getState()
			expect(registry.getState()).toBe(first)

			registry.stores.user.mutate(draft => {
				draft.name = 'changed'
			})

			expect(registry.getState()).not.toBe(first)
			expect(registry.getState().user.name).toBe('changed')
		})

		it('notifies subscribers when any member changes', () => {
			const registry = createRegistry({
				user: createStore<UserState>({ initialState: { name: 'beni' } }).with(immer()),
				cart: createStore<CartState>({ initialState: { items: 0 } }).with(immer()),
			})
			const listener = vi.fn()
			registry.subscribe(listener)

			registry.stores.cart.mutate(draft => {
				draft.items = 3
			})

			expect(listener).toHaveBeenCalledWith(expect.objectContaining({ cart: { items: 3 } }))
		})
	})

	describe('typed store access', () => {
		it('preserves plugin extensions per store', () => {
			const registry = createRegistry({
				user: createStore<UserState>({ initialState: { name: 'beni' } })
					.with(immer())
					.with(history<UserState>()),
				cart: createStore<CartState>({ initialState: { items: 0 } }).with(immer()),
			})

			registry.stores.user.mutate(draft => {
				draft.name = 'changed'
			})

			// undo() existing here is the compile-time proof; cart has no such method
			expect(registry.stores.user.undo()).toBe(true)
			expect(registry.getState().user.name).toBe('beni')
		})
	})

	describe('coordinated operations', () => {
		it('resetAll resets every store', () => {
			const registry = createRegistry({
				user: createStore<UserState>({ initialState: { name: 'beni' } }).with(immer()),
				cart: createStore<CartState>({ initialState: { items: 0 } }).with(immer()),
			})

			registry.stores.user.mutate(draft => {
				draft.name = 'x'
			})
			registry.stores.cart.mutate(draft => {
				draft.items = 9
			})

			registry.resetAll()

			expect(registry.getState()).toEqual({
				user: { name: 'beni' },
				cart: { items: 0 },
			})
		})
	})

	describe('destroyAll', () => {
		it('destroys every store and rejects further use', () => {
			const registry = createRegistry({
				user: createStore<UserState>({ initialState: { name: 'a' } }).with(immer()),
			})

			registry.destroyAll()

			expect(() => registry.getState()).toThrow(StoreError)
			expect(() => registry.stores.user.getState()).toThrow('destroyed')
			// Second call is a no-op, matching store.destroy()
			expect(() => registry.destroyAll()).not.toThrow()
		})
	})

	describe('listeners', () => {
		it('reports a listener that throws, and still calls the rest', () => {
			const registry = createRegistry({
				user: createStore<UserState>({ initialState: { name: 'a' } }),
			})
			const later = vi.fn()
			registry.subscribe(() => {
				throw new Error('listener failed')
			})
			registry.subscribe(later)

			registry.stores.user.set({ name: 'b' })

			expect(later).toHaveBeenCalled()
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining('[clutch]'),
				expect.objectContaining({ message: 'listener failed' }),
			)
		})
	})
})
