/*
 *   IMPORTS
 ***************************************************************************************************/
import type { Plugin, PluginContext } from '../core'
import { StoreError, toStoreError } from '../error'
import { isStateObject, type Patch } from '../patch'
import { parseSchema, type StandardSchemaV1 } from './standard-schema'

/*
 *   TYPES
 ***************************************************************************************************/
type Awaitable<V> = V | Promise<V>

export interface PersistStorage {
	getItem(key: string): Awaitable<string | null>
	setItem(key: string, value: string): Awaitable<void>
	removeItem(key: string): Awaitable<void>
}

interface PersistedEnvelope<T> {
	state: T
	timestamp: number
	version?: number
}

type WriteOperation = { kind: 'set'; value: string } | { kind: 'remove' }

interface QueuedWrite {
	operation: WriteOperation
	promise: Promise<void>
	resolve: () => void
}

type StoredResult<T> =
	| { kind: 'state'; state: Partial<T> }
	| { kind: 'discarded'; error: StoreError }
	| { kind: 'failed'; error: StoreError; shouldBlockWrites: boolean }

export interface PersistConfig<T extends object> {
	key: string
	/** Picks what gets stored, and the only keys read back. Everything when omitted. */
	pick?: (state: T) => Partial<T>
	/** Checks stored state after `migrate`, and what it returns is what gets applied. */
	schema?: StandardSchemaV1<Partial<T>>
	storage?: PersistStorage
	debounceMs?: number
	maxChars?: number
	/** Reads stored state on install. When false, call `hydrate()` yourself. Defaults to true. */
	autoStart?: boolean
	version?: number
	migrate?: (persisted: unknown, fromVersion: number) => Partial<T>
}

export interface PersistApi {
	hydrate(): Promise<boolean>
	isHydrated(): boolean
	/** Writes a pending change now. Settles when the write does. */
	flush(): Promise<void>
	/** Removes what is stored. Settles when the removal does. */
	clearPersisted(): Promise<void>
}

const PERSIST_SOURCE = 'persist'
const DEFAULT_DEBOUNCE_MS = 300
const DEFAULT_MAX_CHARS = 5 * 1024 * 1024

/*
 *   HELPERS
 ***************************************************************************************************/
function getDefaultStorage(): PersistStorage | null {
	try {
		// localStorage can be missing or blocked even where window exists
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (typeof window === 'undefined' || !window.localStorage) {
			return null
		}

		return window.localStorage
	} catch {
		return null
	}
}

function isThenable<V>(value: Awaitable<V>): value is Promise<V> {
	return typeof (value as Promise<V> | null)?.then === 'function'
}

function parseJson(stored: string): unknown {
	try {
		return JSON.parse(stored, (key, value: unknown) =>
			key === '__proto__' ? undefined : value,
		)
	} catch (error) {
		// The parser quotes the start of the value, which can be a token
		throw new StoreError('Persisted value is not valid JSON', 'PERSISTENCE_FAILED', {
			cause: error,
		})
	}
}

/*
 *   WRITE QUEUE
 ***************************************************************************************************/
// Async storage: one write in flight, and only the newest of the rest is kept, so the last write
// wins even when an earlier one is slower. Sync storage writes straight away.
function createWriteQueue(
	storage: PersistStorage,
	key: string,
	onFailure: (error: unknown, operation: WriteOperation) => void,
) {
	let isWriting = false
	let inFlight: Promise<void> = Promise.resolve()
	let queued: QueuedWrite | null = null

	function perform(operation: WriteOperation): Awaitable<void> {
		return operation.kind === 'set'
			? storage.setItem(key, operation.value)
			: storage.removeItem(key)
	}

	function run(operation: WriteOperation): Promise<void> {
		let result: Awaitable<void>

		try {
			result = perform(operation)
		} catch (error) {
			onFailure(error, operation)

			return Promise.resolve()
		}

		if (!isThenable(result)) {
			return Promise.resolve()
		}

		isWriting = true
		inFlight = result
			.then(
				() => {},
				(error: unknown) => onFailure(error, operation),
			)
			.then(() => {
				isWriting = false
				const next = queued
				queued = null

				if (next) {
					void run(next.operation).then(next.resolve)
				}
			})

		return inFlight
	}

	return {
		write(operation: WriteOperation): Promise<void> {
			if (!isWriting) {
				return run(operation)
			}

			if (queued) {
				queued.operation = operation

				return queued.promise
			}

			let resolve = (): void => {}
			const promise = new Promise<void>(done => {
				resolve = done
			})
			queued = { operation, promise, resolve }

			return promise
		},

		whenIdle(): Promise<void> {
			return queued ? queued.promise : inFlight
		},
	}
}

/*
 *   READING
 ***************************************************************************************************/
// Turns a stored value into the state to apply. Never throws: what went wrong comes back as a
// result, with whether it should stop later writes from overwriting the stored data
function parseStored<T extends object>(
	stored: string,
	config: PersistConfig<T>,
	maxChars: number,
): StoredResult<T> {
	const fail = (error: StoreError, shouldBlockWrites = false): StoredResult<T> => ({
		kind: 'failed',
		error,
		shouldBlockWrites,
	})

	if (stored.length > maxChars) {
		return fail(new StoreError('Persisted value is larger than maxChars', 'PERSISTENCE_FAILED'))
	}

	let parsed: unknown

	try {
		parsed = parseJson(stored)
	} catch (error) {
		return fail(error as StoreError)
	}

	if (!isStateObject(parsed) || !isStateObject(parsed.state)) {
		return fail(new StoreError('Persisted data has an unexpected shape', 'PERSISTENCE_FAILED'))
	}

	if (parsed.version !== undefined && typeof parsed.version !== 'number') {
		return fail(new StoreError('Persisted version is not a number', 'PERSISTENCE_FAILED'))
	}

	const persistedVersion = parsed.version ?? 0
	const expectedVersion = config.version ?? 0
	let state: unknown = parsed.state

	if (persistedVersion !== expectedVersion) {
		if (!config.migrate) {
			return {
				kind: 'discarded',
				error: new StoreError(
					`Discarded "${config.key}": it was persisted as version ${persistedVersion}, this app expects ${expectedVersion} and no migrate() is configured`,
					'PERSISTENCE_FAILED',
				),
			}
		}

		// Whatever goes wrong from here keeps the stored blob, so a fixed migrate can still read it
		try {
			state = config.migrate(state, persistedVersion)
		} catch (error) {
			return fail(
				toStoreError(error, 'PERSISTENCE_FAILED', 'Persisted state migration failed'),
				true,
			)
		}

		if (!isStateObject(state)) {
			return fail(
				new StoreError('migrate() must return an object', 'PERSISTENCE_FAILED'),
				true,
			)
		}
	}

	if (config.schema) {
		const result = parseSchema(config.schema, state)

		// Likely written by another version of the app, so keep it rather than overwrite it
		if (!result.ok) {
			return fail(
				new StoreError(
					`Persisted state failed the schema: ${result.message}`,
					'PERSISTENCE_FAILED',
					{ cause: result.issues },
				),
				true,
			)
		}

		if (!isStateObject(result.value)) {
			return fail(
				new StoreError(
					'Persisted state failed the schema: not an object',
					'PERSISTENCE_FAILED',
				),
				true,
			)
		}

		state = result.value
	}

	return { kind: 'state', state: state as Partial<T> }
}

/*
 *   PLUGIN
 ***************************************************************************************************/
export function persist<T extends object>(config: PersistConfig<T>): Plugin<T, PersistApi> {
	if (!config.key) {
		throw new StoreError('Persist key is required', 'INVALID_ARGUMENT')
	}

	const debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS
	const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS
	const storage = config.storage ?? getDefaultStorage()

	let ctx: PluginContext<T> | null = null
	let hasHydrated = false
	let hydrating: Promise<boolean> | null = null
	let isWriteBlocked = false
	let timer: ReturnType<typeof setTimeout> | null = null
	let pagehideHandler: (() => void) | null = null

	// What changed before hydration landed, so those keys win over what was stored
	let hasChangedBeforeHydration = false
	let hasReplacedEverything = false
	const changedKeys = new Set<string>()

	function report(error: StoreError): void {
		ctx?.emitError(error, PERSIST_SOURCE)
	}

	function reportThrown(error: unknown, message: string): void {
		const isQuota = error instanceof Error && error.name === 'QuotaExceededError'

		report(
			toStoreError(error, 'PERSISTENCE_FAILED', isQuota ? 'Storage quota exceeded' : message),
		)
	}

	const queue = storage
		? createWriteQueue(storage, config.key, (error, operation) => {
				reportThrown(
					error,
					operation.kind === 'set'
						? 'Failed to write persisted state'
						: 'Failed to clear persisted state',
				)
			})
		: null

	/*
	 * WRITING
	 */
	function persistNow(): Promise<void> {
		if (!ctx || !queue || isWriteBlocked) {
			return Promise.resolve()
		}

		try {
			const state = ctx.getState()
			const envelope: PersistedEnvelope<Partial<T>> = {
				state: config.pick ? config.pick(state) : state,
				timestamp: Date.now(),
			}

			if (config.version !== undefined) {
				envelope.version = config.version
			}

			const serialized = JSON.stringify(envelope)

			if (serialized.length > maxChars) {
				report(new StoreError('State too large to persist', 'PERSISTENCE_FAILED'))

				return Promise.resolve()
			}

			return queue.write({ kind: 'set', value: serialized })
		} catch (error) {
			reportThrown(error, 'Failed to write persisted state')

			return Promise.resolve()
		}
	}

	function scheduleWrite(): void {
		if (!queue || timer) {
			return
		}

		timer = setTimeout(() => {
			timer = null
			void persistNow()
		}, debounceMs)
	}

	function handleChange(patches: Patch[] | undefined): void {
		// Writing before hydration would overwrite what is stored with state that never saw it
		if (hasHydrated) {
			scheduleWrite()

			return
		}

		hasChangedBeforeHydration = true

		if (!patches || patches.some(patch => patch.path.length === 0)) {
			hasReplacedEverything = true
		} else {
			patches.forEach(patch => changedKeys.add(String(patch.path[0])))
		}
	}

	function flush(): Promise<void> {
		if (timer) {
			clearTimeout(timer)
			timer = null

			return persistNow()
		}

		return queue ? queue.whenIdle() : Promise.resolve()
	}

	/*
	 * READING
	 */
	// What hydration may set: the picked keys, minus whatever changed locally before it landed
	function getApplicableEntries(current: T, stored: Partial<T>): [string, unknown][] {
		if (hasReplacedEverything) {
			return []
		}

		const allowed = config.pick ? new Set(Object.keys(config.pick(current))) : null

		return Object.entries(stored).filter(
			([key]) => !changedKeys.has(key) && (!allowed || allowed.has(key)),
		)
	}

	function applyStored(stored: string | null): boolean {
		if (!ctx || !stored) {
			return false
		}

		const result = parseStored(stored, config, maxChars)

		if (result.kind !== 'state') {
			report(result.error)
			isWriteBlocked = result.kind === 'failed' && result.shouldBlockWrites

			return false
		}

		const current = ctx.getState()
		const entries = getApplicableEntries(current, result.state)

		if (entries.length === 0) {
			return false
		}

		ctx.replaceState(
			{ ...current, ...Object.fromEntries(entries) },
			{ source: PERSIST_SOURCE, description: 'Hydration' },
		)

		return true
	}

	function finishHydration(stored: string | null): boolean {
		hasHydrated = true
		hydrating = null

		let hasApplied = false

		try {
			hasApplied = applyStored(stored)
		} catch (error) {
			report(toStoreError(error, 'PERSISTENCE_FAILED', `Could not read "${config.key}"`))
		}

		if (!hasApplied) {
			// Nothing was applied, so tell subscribers the flag changed
			ctx?.notify()
		}

		if (hasChangedBeforeHydration) {
			hasChangedBeforeHydration = false
			scheduleWrite()
		}

		changedKeys.clear()
		hasReplacedEverything = false

		return hasApplied
	}

	function failHydration(error: unknown): boolean {
		hasHydrated = true
		hydrating = null
		report(toStoreError(error, 'PERSISTENCE_FAILED', `Could not read "${config.key}"`))
		ctx?.notify()

		return false
	}

	function hydrate(): Promise<boolean> {
		if (hydrating) {
			return hydrating
		}

		if (!ctx || hasHydrated) {
			return Promise.resolve(false)
		}

		if (!storage) {
			hasHydrated = true
			ctx.notify()

			return Promise.resolve(false)
		}

		let stored: Awaitable<string | null>

		try {
			stored = storage.getItem(config.key)
		} catch (error) {
			return Promise.resolve(failHydration(error))
		}

		// Sync storage hydrates before `.with()` returns. The promise only exists for async storage
		if (!isThenable(stored)) {
			return Promise.resolve(finishHydration(stored))
		}

		hydrating = stored.then(finishHydration, failHydration)

		return hydrating
	}

	function clearPersisted(): Promise<void> {
		// A pending write would bring the data straight back
		if (timer) {
			clearTimeout(timer)
			timer = null
		}

		isWriteBlocked = false

		return queue ? queue.write({ kind: 'remove' }) : Promise.resolve()
	}

	return {
		name: PERSIST_SOURCE,

		onInit(context) {
			ctx = context

			if (typeof window !== 'undefined' && storage) {
				pagehideHandler = () => {
					void flush()
				}

				window.addEventListener('pagehide', pagehideHandler)
			}

			if (config.autoStart ?? true) {
				void hydrate()
			}

			return {
				hydrate,
				isHydrated: () => hasHydrated,
				flush,
				clearPersisted,
			}
		},

		// External updates (sync, undo via history) get persisted too. The core
		// skips our own source, so hydration never immediately rewrites storage.
		onCommit: payload => {
			handleChange(payload.patches)
		},

		onExternalState(_state, meta) {
			// A reset is a request to start over, which includes data a failed read had protected
			if (meta.source === 'reset') {
				isWriteBlocked = false
			}

			handleChange(meta.patches)
		},

		onDestroy() {
			void flush()

			if (pagehideHandler && typeof window !== 'undefined') {
				window.removeEventListener('pagehide', pagehideHandler)
				pagehideHandler = null
			}

			ctx = null
		},
	}
}
