/*
 *   IMPORTS
 ***************************************************************************************************/
import type { Store } from './core'
import { StoreError } from './error'

/*
 *   TYPES
 ***************************************************************************************************/
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StoreMap = Record<string, Store<any>>

export type RegistryState<M extends StoreMap> = {
	[K in keyof M]: M[K] extends Store<infer S> ? S : never
}

export type RegistryListener<M extends StoreMap> = (state: RegistryState<M>) => void

/*
 *   REGISTRY
 ***************************************************************************************************/
export class Registry<M extends StoreMap> {
	// Direct typed access: registry.stores.user keeps the plugin extensions
	// that were installed on that store
	public readonly stores: M

	private listeners: Set<RegistryListener<M>> = new Set()
	private unsubscribers: (() => void)[] = []
	private cached: RegistryState<M> | null = null
	private isDestroyed = false

	constructor(stores: M) {
		this.stores = stores

		for (const store of Object.values(stores)) {
			this.unsubscribers.push(
				store.subscribe(() => {
					this.cached = null
					this.notify()
				}),
			)
		}
	}

	/*
	 * STATE ACCESS
	 */
	public getState(): RegistryState<M> {
		this.assertNotDestroyed()

		if (!this.cached) {
			const combined = {} as RegistryState<M>

			for (const key of Object.keys(this.stores) as (keyof M)[]) {
				const store = this.stores[key]

				if (store) {
					combined[key] = store.getState() as RegistryState<M>[typeof key]
				}
			}

			this.cached = combined
		}

		return this.cached
	}

	public subscribe(listener: RegistryListener<M>): () => void {
		this.assertNotDestroyed()

		if (typeof listener !== 'function') {
			throw new StoreError('Listener must be a function', 'INVALID_ARGUMENT')
		}

		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	/*
	 * COORDINATED OPERATIONS
	 */
	public resetAll(): void {
		this.assertNotDestroyed()

		for (const store of Object.values(this.stores)) {
			store.reset()
		}
	}

	public destroyAll(): void {
		if (this.isDestroyed) {
			return
		}

		for (const unsubscribe of this.unsubscribers) {
			unsubscribe()
		}

		this.unsubscribers = []

		for (const store of Object.values(this.stores)) {
			store.destroy()
		}

		this.listeners.clear()
		this.isDestroyed = true
	}

	/*
	 * PRIVATE METHODS
	 */
	private assertNotDestroyed(): void {
		if (this.isDestroyed) {
			throw new StoreError('Cannot operate on destroyed Registry', 'DESTROYED')
		}
	}

	private notify(): void {
		if (this.listeners.size === 0) {
			return
		}

		const combined = this.getState()

		this.listeners.forEach(listener => {
			try {
				listener(combined)
			} catch (error) {
				// One broken listener should not stop the others. A registry has no `onError` of its own
				console.error('[clutch] A registry listener threw', error)
			}
		})
	}
}

/*
 *   FACTORY
 ***************************************************************************************************/
export function createRegistry<M extends StoreMap>(stores: M): Registry<M> {
	return new Registry(stores)
}
