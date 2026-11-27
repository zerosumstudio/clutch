/*
 *   IMPORTS
 ***************************************************************************************************/
import type { Plugin, PluginContext } from '../core'
import { StoreError, toStoreError } from '../error'

/*
 *   TYPES
 ***************************************************************************************************/
export interface AutosaveConfig<T> {
	save: (state: T) => void | Promise<void>
	load?: () => T | null | Promise<T | null>
	intervalMs?: number
	/** Saves on an interval when there are unsaved changes. Defaults to true. */
	autoStart?: boolean
}

export type AutosaveState =
	| { status: 'idle' | 'saving' | 'loading'; lastSavedAt: number | null }
	| { status: 'error'; error: StoreError; lastSavedAt: number | null }

export interface AutosaveApi {
	save(): Promise<void>
	load(): Promise<boolean>
	hasUnsavedChanges(): boolean
	/** The same object until the state changes. */
	getAutosaveState(): AutosaveState
}

const AUTOSAVE_SOURCE = 'autosave'
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

// Updates from these sources are already saved elsewhere. Anything else, including undo and
// reset, leaves the saved copy behind
const SAVED_ELSEWHERE_SOURCES = new Set(['sync', AUTOSAVE_SOURCE])

/*
 *   PLUGIN
 ***************************************************************************************************/
export function autosave<T extends object>(config: AutosaveConfig<T>): Plugin<T, AutosaveApi> {
	if (typeof config.save !== 'function') {
		throw new StoreError('Autosave requires a save function', 'INVALID_ARGUMENT')
	}

	const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS

	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new StoreError('Auto-save interval must be a positive number', 'INVALID_ARGUMENT')
	}

	let ctx: PluginContext<T> | null = null
	// Counts every change that leaves the saved copy behind. A save only covers what it started
	// with, so a change made while it ran stays unsaved
	let version = 0
	let savedVersion = 0
	let inFlight: Promise<void> | null = null
	let state: AutosaveState = { status: 'idle', lastSavedAt: null }
	let timer: ReturnType<typeof setInterval> | null = null

	// The store can be destroyed while a save or load is awaited
	const isDestroyed = (): boolean => ctx === null

	const hasUnsavedChanges = (): boolean => version !== savedVersion

	const setState = (next: AutosaveState): void => {
		state = next
		ctx?.notify()
	}

	const runSave = async (current: PluginContext<T>): Promise<void> => {
		const startedAt = version

		setState({ status: 'saving', lastSavedAt: state.lastSavedAt })

		try {
			await config.save(current.getState())
		} catch (error) {
			const failure = toStoreError(error, 'AUTOSAVE_FAILED', 'Autosave failed')

			if (!isDestroyed()) {
				setState({ status: 'error', error: failure, lastSavedAt: state.lastSavedAt })
				current.emitError(failure, AUTOSAVE_SOURCE)
			}

			throw failure
		}

		if (isDestroyed()) {
			return
		}

		savedVersion = startedAt
		setState({ status: 'idle', lastSavedAt: Date.now() })
	}

	const save = async (): Promise<void> => {
		// One save at a time. A caller that arrives mid-save waits, then saves what is still unsaved
		while (inFlight) {
			await inFlight.catch(() => {})
		}

		if (!ctx || !hasUnsavedChanges()) {
			return
		}

		inFlight = runSave(ctx)

		try {
			await inFlight
		} finally {
			inFlight = null
		}
	}

	const load = async (): Promise<boolean> => {
		if (!ctx || !config.load) {
			return false
		}

		const current = ctx

		setState({ status: 'loading', lastSavedAt: state.lastSavedAt })

		try {
			const serverState = await config.load()

			if (isDestroyed()) {
				return false
			}

			if (!serverState) {
				setState({ status: 'idle', lastSavedAt: state.lastSavedAt })

				return false
			}

			current.replaceState(serverState, {
				source: AUTOSAVE_SOURCE,
				description: 'Server load',
			})
			savedVersion = version
			setState({ status: 'idle', lastSavedAt: Date.now() })

			return true
		} catch (error) {
			const failure = toStoreError(error, 'AUTOSAVE_FAILED', 'Autosave load failed')

			if (!isDestroyed()) {
				setState({ status: 'error', error: failure, lastSavedAt: state.lastSavedAt })
				current.emitError(failure, AUTOSAVE_SOURCE)
			}

			throw failure
		}
	}

	const startTimer = (): void => {
		timer = setInterval(() => {
			if (hasUnsavedChanges()) {
				// Failures are already reported through emitError
				save().catch(() => {})
			}
		}, intervalMs)
		// Never keep a Node process alive just to autosave
		;(timer as { unref?: () => void }).unref?.()
	}

	return {
		name: AUTOSAVE_SOURCE,

		onInit(context) {
			ctx = context

			if (config.autoStart ?? true) {
				startTimer()
			}

			return {
				save,
				load,
				hasUnsavedChanges,
				getAutosaveState: () => state,
			}
		},

		onCommit() {
			version++
		},

		onExternalState(_state, meta) {
			if (!SAVED_ELSEWHERE_SOURCES.has(meta.source)) {
				version++
			}
		},

		onDestroy() {
			if (timer) {
				clearInterval(timer)
				timer = null
			}

			ctx = null
		},
	}
}
