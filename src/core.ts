/*
 *   IMPORTS
 ***************************************************************************************************/
import { StoreError, toStoreError } from './error'
import { applyPatches, deepFreeze, diffState, isStateObject, type Patch } from './patch'

/*
 *   TYPES
 ***************************************************************************************************/
export interface CommitPayload<T> {
	state: T
	patches: Patch[]
	inversePatches: Patch[]
	description: string | undefined
	timestamp: number
}

export interface CommitOptions {
	/** Omit to diff the top-level keys of the new state. */
	patches?: Patch[] | undefined
	inversePatches?: Patch[] | undefined
	description?: string | undefined
}

export interface ExternalStateMeta {
	source: string
	patches?: Patch[] | undefined
	description?: string | undefined
}

export interface PluginContext<T extends object> {
	getState(): T
	/**
	 * A local change: runs `onBeforeCommit` (which can veto), applies the state, then runs
	 * `onCommit`. Without `patches` the top-level keys are diffed.
	 */
	commit(state: T, options?: CommitOptions): void
	/**
	 * Replaces state from outside the normal update path, e.g. a remote update, hydration, or
	 * time travel. Subscribers are notified and every plugin except the one named in
	 * `meta.source` gets `onExternalState`.
	 */
	replaceState(state: T, meta: ExternalStateMeta): void
	applyPatches(patches: Patch[], meta: Omit<ExternalStateMeta, 'patches'>): void
	subscribe(listener: (state: T) => void): () => void
	/** Publishes a change a plugin exposes through its own API, without touching state. */
	notify(): void
	emitError(error: StoreError, operation: string): void
}

// An empty object type on purpose: it adds nothing when a plugin has no extension
// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type
type NoExtension = Record<never, never>

export interface Plugin<T extends object, Ext extends object = NoExtension> {
	name: string
	/** Whatever this returns gets merged onto the store by `.with()` and shows up in its type. */
	onInit?(ctx: PluginContext<T>): Ext | void
	/** Throw here to veto the commit before any state is applied. */
	onBeforeCommit?(payload: CommitPayload<T>): void
	onCommit?(payload: CommitPayload<T>): void
	onExternalState?(state: T, meta: ExternalStateMeta): void
	onError?(error: StoreError, operation: string): void
	onDestroy?(finalState: T): void
}

export interface StoreConfig<T extends object> {
	initialState: T
}

/** A store whose state can be read and replaced from outside, whatever plugins it has. */
export interface StatefulStore {
	getState(): unknown
	replaceState(state: unknown, meta: ExternalStateMeta): void
}

export function isStatefulStore(value: unknown): value is StatefulStore {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as StatefulStore).getState === 'function' &&
		typeof (value as StatefulStore).replaceState === 'function'
	)
}

/*
 *   EQUALITY
 ***************************************************************************************************/
function areMapsEqual(a: Map<unknown, unknown>, b: Map<unknown, unknown>): boolean {
	return (
		a.size === b.size &&
		[...a].every(([key, value]) => b.has(key) && Object.is(value, b.get(key)))
	)
}

function areSetsEqual(a: Set<unknown>, b: Set<unknown>): boolean {
	return a.size === b.size && [...a].every(value => b.has(value))
}

function areObjectsEqual(a: object, b: object): boolean {
	const left = a as Record<string, unknown>
	const right = b as Record<string, unknown>
	const keys = Object.keys(left)

	return (
		Array.isArray(a) === Array.isArray(b) &&
		keys.length === Object.keys(right).length &&
		keys.every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]))
	)
}

/** Compares two objects, maps or sets one level deep, for selectors that return a fresh value. */
export function shallowEqual<T>(a: T, b: T): boolean {
	if (Object.is(a, b)) {
		return true
	}

	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		return false
	}

	if (a instanceof Map || b instanceof Map) {
		return a instanceof Map && b instanceof Map && areMapsEqual(a, b)
	}

	if (a instanceof Set || b instanceof Set) {
		return a instanceof Set && b instanceof Set && areSetsEqual(a, b)
	}

	return areObjectsEqual(a, b)
}

/*
 *   STORE
 ***************************************************************************************************/
export class Store<T extends object> {
	private state: T
	private readonly initialState: T
	private listeners: Set<(state: T) => void> = new Set()
	private plugins: Plugin<T, object>[] = []
	private isDestroyed = false
	private readonly ctx: PluginContext<T>

	constructor(config: StoreConfig<T>) {
		if (!isStateObject((config as Partial<StoreConfig<T>> | undefined)?.initialState)) {
			throw new StoreError('Initial state must be an object', 'INVALID_ARGUMENT')
		}

		this.state = deepFreeze(config.initialState)
		this.initialState = this.state

		this.ctx = {
			getState: () => this.getState(),
			commit: (state, options) => this.commit(state, options),
			replaceState: (state, meta) => this.applyExternalState(state, meta),
			applyPatches: (patches, meta) => {
				this.assertNotDestroyed()
				this.applyExternalState(applyPatches(this.state, patches), { ...meta, patches })
			},
			subscribe: listener => this.subscribe(listener),
			notify: () => this.notifyListeners(),
			emitError: (error, operation) => this.emitError(error, operation),
		}
	}

	/*
	 * PLUGIN INSTALLATION
	 */
	public with<Ext extends object>(plugin: Plugin<T, Ext>): this & Ext {
		this.assertNotDestroyed()

		if (this.plugins.some(installed => installed.name === plugin.name)) {
			throw new StoreError(`Plugin "${plugin.name}" is already installed`, 'DUPLICATE_PLUGIN')
		}

		try {
			const extension = plugin.onInit?.(this.ctx)

			if (extension) {
				this.installExtension(plugin.name, extension)
			}
		} catch (error) {
			// A failed install must not leave timers or listeners behind
			try {
				plugin.onDestroy?.(this.state)
			} catch {
				// The original error is the one worth reporting
			}

			throw error
		}

		this.plugins.push(plugin)

		return this as this & Ext
	}

	/*
	 * CORE METHODS
	 */
	public getState(): T {
		this.assertNotDestroyed()

		return this.state
	}

	public subscribe(listener: (state: T) => void): () => void
	public subscribe<S>(
		selector: (state: T) => S,
		listener: (next: S, previous: S) => void,
		isEqual?: (a: S, b: S) => boolean,
	): () => void
	public subscribe<S>(
		selectorOrListener: ((state: T) => void) | ((state: T) => S),
		maybeListener?: (next: S, previous: S) => void,
		isEqual: (a: S, b: S) => boolean = Object.is,
	): () => void {
		this.assertNotDestroyed()

		if (typeof selectorOrListener !== 'function') {
			throw new StoreError('Listener must be a function', 'INVALID_ARGUMENT')
		}

		if (typeof maybeListener !== 'function') {
			const listener = selectorOrListener
			this.listeners.add(listener)

			return () => {
				this.listeners.delete(listener)
			}
		}

		const selector = selectorOrListener as (state: T) => S
		let current = selector(this.state)
		const wrapped = (state: T): void => {
			const next = selector(state)

			if (!isEqual(current, next)) {
				const previous = current
				current = next
				maybeListener(next, previous)
			}
		}

		this.listeners.add(wrapped)

		return () => {
			this.listeners.delete(wrapped)
		}
	}

	/** Shallow merge, from a partial or from a function of the current state. */
	public set(update: Partial<T> | ((state: T) => Partial<T>), description?: string): void {
		this.assertNotDestroyed()

		const partial: unknown = typeof update === 'function' ? update(this.state) : update

		if (!partial || typeof partial !== 'object') {
			throw new StoreError('Partial state must be an object', 'INVALID_ARGUMENT')
		}

		this.commit({ ...this.state, ...(partial as Partial<T>) }, { description })
	}

	/*
	 * RESET
	 */
	public getInitialState(): T {
		return this.initialState
	}

	public reset(): void {
		this.assertNotDestroyed()
		this.applyExternalState(this.initialState, {
			source: 'reset',
			description: 'State Reset',
		})
	}

	public replaceState(state: T, meta: ExternalStateMeta = { source: 'replace' }): void {
		this.applyExternalState(state, meta)
	}

	/*
	 * CLEANUP
	 */
	public destroy(): void {
		if (this.isDestroyed) {
			return
		}

		const finalState = this.state

		// Tear down in reverse install order since later plugins may depend on earlier ones
		for (let i = this.plugins.length - 1; i >= 0; i--) {
			try {
				this.plugins[i]?.onDestroy?.(finalState)
			} catch (error) {
				this.emitError(
					toStoreError(error, 'PLUGIN_FAILED'),
					`plugin:${this.plugins[i]?.name}:onDestroy`,
				)
			}
		}

		this.isDestroyed = true
		this.listeners.clear()
		this.plugins = []
	}

	/*
	 * PRIVATE METHODS
	 */
	private installExtension(pluginName: string, extension: object): void {
		for (const key of Object.keys(extension)) {
			if (key in this) {
				throw new StoreError(
					`Plugin "${pluginName}" extension "${key}" collides with an existing member`,
					'EXTENSION_COLLISION',
				)
			}
		}

		Object.assign(this, extension)
	}

	private assertNotDestroyed(): void {
		if (this.isDestroyed) {
			throw new StoreError('Cannot operate on destroyed Store', 'DESTROYED')
		}
	}

	private assertValidState(state: unknown): asserts state is T {
		if (!isStateObject(state)) {
			throw new StoreError('State must be an object', 'INVALID_ARGUMENT')
		}
	}

	private commit(nextState: T, options: CommitOptions = {}): void {
		this.assertNotDestroyed()
		this.assertValidState(nextState)

		const { patches, inversePatches } = options.patches
			? { patches: options.patches, inversePatches: options.inversePatches ?? [] }
			: diffState(this.state, nextState)

		if (patches.length === 0) {
			return
		}

		const state = deepFreeze(nextState)
		const payload: CommitPayload<T> = {
			state,
			patches,
			inversePatches,
			description: options.description,
			timestamp: Date.now(),
		}

		for (const plugin of this.plugins) {
			plugin.onBeforeCommit?.(payload)
		}

		this.state = state

		for (const plugin of this.plugins) {
			try {
				plugin.onCommit?.(payload)
			} catch (error) {
				this.emitError(
					toStoreError(error, 'PLUGIN_FAILED'),
					`plugin:${plugin.name}:onCommit`,
				)
			}
		}

		this.notifyListeners()
	}

	private applyExternalState(nextState: T, meta: ExternalStateMeta): void {
		this.assertNotDestroyed()
		this.assertValidState(nextState)

		this.state = deepFreeze(nextState)

		for (const plugin of this.plugins) {
			if (plugin.name === meta.source) {
				continue
			}

			try {
				plugin.onExternalState?.(this.state, meta)
			} catch (error) {
				this.emitError(
					toStoreError(error, 'PLUGIN_FAILED'),
					`plugin:${plugin.name}:onExternalState`,
				)
			}
		}

		this.notifyListeners()
	}

	private notifyListeners(): void {
		this.listeners.forEach(listener => {
			try {
				listener(this.state)
			} catch (error) {
				this.emitError(toStoreError(error, 'PLUGIN_FAILED'), 'notify')
			}
		})
	}

	private emitError(error: StoreError, operation: string): void {
		let isHandled = false

		for (const plugin of this.plugins) {
			if (plugin.onError) {
				isHandled = true
				try {
					plugin.onError(error, operation)
				} catch {
					// A throwing error handler should not take down the rest
				}
			}
		}

		if (!isHandled) {
			console.error(`[clutch] Unhandled error during ${operation}`, error)
		}
	}
}

/*
 *   FACTORY
 ***************************************************************************************************/
export function createStore<T extends object>(config: StoreConfig<T>): Store<T> {
	return new Store(config)
}
