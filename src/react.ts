/*
 *   IMPORTS
 ***************************************************************************************************/
import {
	createContext,
	createElement,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactElement,
	type ReactNode,
} from 'react'
import { isStatefulStore, shallowEqual, type Store } from './core'
import { StoreError } from './error'
import type { Registry, RegistryState, StoreMap } from './registry'
import type { HistoryApi, HistoryInfo } from './plugins/history'
import type { PersistApi } from './plugins/persist'
import type { AutosaveApi, AutosaveState } from './plugins/autosave'

/*
 *   TYPES
 ***************************************************************************************************/
type Subscribe = (onStoreChange: () => void) => () => void

interface Subscribable {
	subscribe(listener: () => void): () => void
}

export type HistoryState = HistoryInfo & Pick<HistoryApi, 'undo' | 'redo' | 'clearHistory'>

export interface HydrationState {
	isHydrated: boolean
}

export type AutosaveHookState = AutosaveState & {
	hasUnsavedChanges: boolean
	/** Resolves true when it saved. A failure shows up in the state, not as a rejection. */
	save(): Promise<boolean>
	/** Resolves true when it loaded. A failure shows up in the state, not as a rejection. */
	load(): Promise<boolean>
}

interface Committed<Selected> {
	hasValue: boolean
	value: Selected | undefined
}

/*
 *   SOURCES
 ***************************************************************************************************/
// A scope's store is destroyed when its tree is hidden or unmounted, and React can re-run a hidden
// tree's effects before the scope has built a new one. A destroyed store reads as its last value and
// ignores subscriptions until the new store arrives.
function isDestroyedError(error: unknown): boolean {
	return error instanceof StoreError && error.code === 'DESTROYED'
}

function subscribeTolerantly(source: Subscribable): Subscribe {
	return onChange => {
		try {
			return source.subscribe(() => onChange())
		} catch (error) {
			if (isDestroyedError(error)) {
				return () => {}
			}

			throw error
		}
	}
}

function readTolerantly<V>(read: () => V): () => V {
	let hasLast = false
	let last: V

	return () => {
		try {
			last = read()
			hasLast = true

			return last
		} catch (error) {
			if (hasLast && isDestroyedError(error)) {
				return last
			}

			throw error
		}
	}
}

// `read` has to be a stable function, so a hook's snapshot doesn't change on every render
function useSource<S extends Subscribable, V>(
	source: S,
	read: (source: S) => V,
): { subscribe: Subscribe; getSnapshot: () => V } {
	const subscribe = useMemo(() => subscribeTolerantly(source), [source])
	const getSnapshot = useMemo(() => readTolerantly(() => read(source)), [source, read])

	return { subscribe, getSnapshot }
}

function useSourceValue<S extends Subscribable, V>(source: S, read: (source: S) => V): V {
	const { subscribe, getSnapshot } = useSource(source, read)

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/*
 *   SELECTION
 ***************************************************************************************************/
function identity<V>(value: V): V {
	return value
}

// A selector over a snapshot, cached against the snapshot's identity. When `isEqual` says a new
// selection matches the previous one, the previous object is kept, so a selector that returns a
// fresh object doesn't loop or re-render without a real change.
function createSelection<Snapshot, Selected>(
	getSnapshot: () => Snapshot,
	selector: (snapshot: Snapshot) => Selected,
	isEqual: (a: Selected, b: Selected) => boolean,
	committed: Committed<Selected>,
): () => Selected {
	let hasMemo = false
	let memoSnapshot: Snapshot
	let memoSelection: Selected

	return () => {
		const snapshot = getSnapshot()

		if (hasMemo && Object.is(memoSnapshot, snapshot)) {
			return memoSelection
		}

		const selection = selector(snapshot)
		// Before this selector's first read, what the component last committed is the one to keep
		const previous: Committed<Selected> = hasMemo
			? { hasValue: true, value: memoSelection }
			: committed

		memoSnapshot = snapshot
		hasMemo = true
		memoSelection =
			previous.hasValue && isEqual(previous.value as Selected, selection)
				? (previous.value as Selected)
				: selection

		return memoSelection
	}
}

function commitSelection<Selected>(committed: Committed<Selected>, selection: Selected): void {
	committed.hasValue = true
	committed.value = selection
}

function useSelection<Snapshot, Selected>(
	subscribe: Subscribe,
	getSnapshot: () => Snapshot,
	selector: (snapshot: Snapshot) => Selected,
	isEqual: (a: Selected, b: Selected) => boolean,
): Selected {
	// Written in an effect and never during render
	const [committed] = useState<Committed<Selected>>(() => ({ hasValue: false, value: undefined }))

	const getSelection = useMemo(
		() => createSelection(getSnapshot, selector, isEqual, committed),
		[getSnapshot, selector, isEqual, committed],
	)

	const selection = useSyncExternalStore(subscribe, getSelection, getSelection)

	useEffect(() => {
		commitSelection(committed, selection)
	}, [committed, selection])

	return selection
}

/*
 *   CORE HOOKS
 ***************************************************************************************************/
function readState<T extends object>(store: Store<T>): T {
	return store.getState()
}

export function useStore<T extends object>(store: Store<T>): T
export function useStore<T extends object, S>(
	store: Store<T>,
	selector: (state: T) => S,
	isEqual?: (a: S, b: S) => boolean,
): S
export function useStore<T extends object, S>(
	store: Store<T>,
	selector: (state: T) => S = identity as unknown as (state: T) => S,
	isEqual: (a: S, b: S) => boolean = Object.is,
): S {
	const { subscribe, getSnapshot } = useSource(store, readState)

	return useSelection(subscribe, getSnapshot, selector, isEqual)
}

export function useSubscription<T extends object>(
	store: Store<T>,
	callback: (state: T) => void,
): void {
	const callbackRef = useRef(callback)

	useEffect(() => {
		callbackRef.current = callback
	}, [callback])

	useEffect(() => {
		return store.subscribe(state => callbackRef.current(state))
	}, [store])
}

/*
 *   REGISTRY HOOKS
 ***************************************************************************************************/
function readRegistryState<M extends StoreMap>(registry: Registry<M>): RegistryState<M> {
	return registry.getState()
}

export function useRegistry<M extends StoreMap>(registry: Registry<M>): RegistryState<M>
export function useRegistry<M extends StoreMap, S>(
	registry: Registry<M>,
	selector: (state: RegistryState<M>) => S,
	isEqual?: (a: S, b: S) => boolean,
): S
export function useRegistry<M extends StoreMap, S>(
	registry: Registry<M>,
	selector: (state: RegistryState<M>) => S = identity as unknown as (
		state: RegistryState<M>,
	) => S,
	isEqual: (a: S, b: S) => boolean = Object.is,
): S {
	const { subscribe, getSnapshot } = useSource(registry, readRegistryState)

	return useSelection(subscribe, getSnapshot, selector, isEqual)
}

/*
 *   SCOPED STORES
 ***************************************************************************************************/
// A module-level store is shared by every concurrent request on a server.
// A scope builds one store per render tree instead.

/** Read structurally, so plugin-wrapped stores still match. */
type ScopedState<M> = M extends { getState(): infer T } ? T : never

interface SeedableStore {
	set(partial: object, description?: string): void
}

interface DestroyableStore {
	destroy(): void
}

export interface StoreScopeProviderProps<T> {
	state?: Partial<T>
	children?: ReactNode
}

export interface StoreScope<M> {
	Provider: (props: StoreScopeProviderProps<ScopedState<M>>) => ReactElement
	useScopedStore: () => M
}

function isSeedable(value: unknown): value is SeedableStore {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as SeedableStore).set === 'function'
	)
}

function isDestroyable(value: unknown): value is DestroyableStore {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as DestroyableStore).destroy === 'function'
	)
}

function seedStore(store: unknown, state: object | undefined): void {
	if (state === undefined || !isSeedable(store)) {
		return
	}

	store.set(state, 'scope seed')
}

/** Destroys a store on the next microtask unless the returned function cancels it first. */
function scheduleDestroy(
	store: unknown,
	destroyedStores: WeakSet<object>,
	lastStates: WeakMap<object, unknown>,
): () => void {
	let isCancelled = false

	queueMicrotask(() => {
		if (isCancelled || !isDestroyable(store)) {
			return
		}

		destroyedStores.add(store)

		if (isStatefulStore(store)) {
			lastStates.set(store, store.getState())
		}

		store.destroy()
	})

	return () => {
		isCancelled = true
	}
}

export function createStoreScope<M>(factory: () => M, name = 'Store'): StoreScope<M> {
	const ScopeContext = createContext<M | null>(null)
	ScopeContext.displayName = `${name}Scope`

	function Provider({ state, children }: StoreScopeProviderProps<ScopedState<M>>) {
		const buildStore = (): M => {
			const created = factory()
			seedStore(created, state)

			return created
		}

		// Created during render so the first render, and server rendering, never see an empty
		// scope. The effect below owns the store from then on
		const [store, setStore] = useState(buildStore)

		const lastSeed = useRef(state)
		const destroyed = useRef(new WeakSet())
		// What a destroyed store held, so the one that replaces it starts from there
		const lastStates = useRef(new WeakMap<object, unknown>())
		const cancelDestroy = useRef<(() => void) | null>(null)

		// Runs once per mount. The cleanup only schedules the destroy: StrictMode runs this effect
		// again straight away, and the children's effects (which subscribe) run before it does, so
		// the store has to still be alive then. A hidden tree that is shown later finds its store
		// destroyed and builds a new one
		useEffect(() => {
			const destroyedStores = destroyed.current
			const remembered = lastStates.current
			let current = store

			cancelDestroy.current?.()
			cancelDestroy.current = null

			if (typeof current === 'object' && current !== null && destroyedStores.has(current)) {
				// A hidden tree keeps its state, so the replacement picks up where the old one was.
				// Replacing is not a commit, so it adds nothing to undo history
				const replacement = factory()

				if (isStatefulStore(replacement) && remembered.has(current)) {
					replacement.replaceState(remembered.get(current), { source: 'scope' })
				}

				current = replacement
				setStore(current)
			}

			return () => {
				cancelDestroy.current = scheduleDestroy(current, destroyedStores, remembered)
			}

			// The store this effect owns is the one from the first render
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [])

		useEffect(() => {
			if (shallowEqual(lastSeed.current, state)) {
				return
			}

			lastSeed.current = state
			seedStore(store, state)
		}, [store, state])

		return createElement(ScopeContext.Provider, { value: store }, children)
	}

	Provider.displayName = `${name}ScopeProvider`

	function useScopedStore(): M {
		const store = useContext(ScopeContext)

		if (store === null) {
			throw new Error(
				`[clutch] The ${name} scope was read outside its Provider. Render the Provider returned by createStoreScope above this component.`,
			)
		}

		return store
	}

	return { Provider, useScopedStore }
}

/*
 *   PLUGIN HOOKS
 ***************************************************************************************************/
// These require the matching plugin's API on the store type, so calling
// them against a store without that plugin is a compile error

function readHistoryInfo(store: HistoryApi & Subscribable): HistoryInfo {
	return store.getHistoryInfo()
}

function readIsHydrated(store: PersistApi & Subscribable): boolean {
	return store.isHydrated()
}

function readAutosaveState(store: AutosaveApi & Subscribable): AutosaveState {
	return store.getAutosaveState()
}

function readHasUnsavedChanges(store: AutosaveApi & Subscribable): boolean {
	return store.hasUnsavedChanges()
}

export function useHistory<T extends object>(store: Store<T> & HistoryApi): HistoryState {
	const historyInfo = useSourceValue(store, readHistoryInfo)

	const undo = useCallback(() => store.undo(), [store])
	const redo = useCallback(() => store.redo(), [store])
	const clearHistory = useCallback(() => {
		store.clearHistory()
	}, [store])

	return { ...historyInfo, undo, redo, clearHistory }
}

export function useHydration<T extends object>(store: Store<T> & PersistApi): HydrationState {
	const isHydrated = useSourceValue(store, readIsHydrated)

	useEffect(() => {
		void store.hydrate()
	}, [store])

	return { isHydrated }
}

export function useAutosave<T extends object>(store: Store<T> & AutosaveApi): AutosaveHookState {
	const autosaveState = useSourceValue(store, readAutosaveState)
	const hasUnsavedChanges = useSourceValue(store, readHasUnsavedChanges)

	// Both report failures through the state, so they never reject into an event handler
	const save = useCallback(
		() =>
			store.save().then(
				() => true,
				() => false,
			),
		[store],
	)
	const load = useCallback(() => store.load().catch(() => false), [store])

	return { ...autosaveState, hasUnsavedChanges, save, load }
}
