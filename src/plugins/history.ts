/*
 *   IMPORTS
 ***************************************************************************************************/
import type { Plugin, PluginContext } from '../core'
import { StoreError, toStoreError } from '../error'
import type { Patch } from '../patch'

/*
 *   TYPES
 ***************************************************************************************************/
interface HistorySnapshot {
	patches: Patch[]
	inversePatches: Patch[]
	timestamp: number
	description?: string | undefined
}

export interface HistoryInfo {
	canUndo: boolean
	canRedo: boolean
	length: number
	currentIndex: number
	lastDescription: string | null
}

export interface HistoryApi {
	undo(): boolean
	redo(): boolean
	canUndo(): boolean
	canRedo(): boolean
	getHistoryInfo(): HistoryInfo
	clearHistory(): void
}

export interface HistoryConfig {
	maxSize?: number
}

const HISTORY_SOURCE = 'history'
const DEFAULT_MAX_SIZE = 50

/*
 *   PLUGIN
 ***************************************************************************************************/
export function history<T extends object>(config: HistoryConfig = {}): Plugin<T, HistoryApi> {
	const maxSize = config.maxSize ?? DEFAULT_MAX_SIZE

	if (!Number.isInteger(maxSize) || maxSize <= 0) {
		throw new StoreError('History maxSize must be a positive integer', 'INVALID_ARGUMENT')
	}

	let ctx: PluginContext<T> | null = null
	let snapshots: HistorySnapshot[] = []
	let index = -1
	let infoCache: HistoryInfo | null = null

	const clearStack = (): void => {
		snapshots = []
		index = -1
		infoCache = null
	}

	const clearHistory = (): void => {
		clearStack()
		ctx?.notify()
	}

	const canUndo = (): boolean => index >= 0
	const canRedo = (): boolean => index < snapshots.length - 1

	// Remote patches make the stack stale once they touch a top-level key it recorded
	const isStaleAfter = (remote: Patch[]): boolean => {
		const touched = new Set<string>()

		for (const snapshot of snapshots) {
			for (const patch of snapshot.patches) {
				touched.add(String(patch.path[0]))
			}
		}

		return remote.some(patch => patch.path.length === 0 || touched.has(String(patch.path[0])))
	}

	const step = (patches: (snapshot: HistorySnapshot) => Patch[], delta: 1 | -1): boolean => {
		const target = delta === -1 ? index : index + 1
		const snapshot = snapshots[target]

		if (!ctx || !snapshot) {
			return false
		}

		// Move the cursor before applying so listeners read the new position. A failed apply
		// puts it back
		index += delta
		infoCache = null

		try {
			ctx.applyPatches(patches(snapshot), {
				source: HISTORY_SOURCE,
				description: snapshot.description,
			})

			return true
		} catch (error) {
			index -= delta
			infoCache = null
			ctx.emitError(
				toStoreError(error, 'PLUGIN_FAILED', delta === -1 ? 'Undo failed' : 'Redo failed'),
				delta === -1 ? 'undo' : 'redo',
			)

			return false
		}
	}

	const undo = (): boolean => step(snapshot => snapshot.inversePatches, -1)
	const redo = (): boolean => step(snapshot => snapshot.patches, 1)

	const getHistoryInfo = (): HistoryInfo => {
		// Keep referentially stable between history changes, since
		// useSyncExternalStore compares snapshots with Object.is
		if (!infoCache) {
			infoCache = {
				canUndo: canUndo(),
				canRedo: canRedo(),
				length: snapshots.length,
				currentIndex: index,
				lastDescription: snapshots[index]?.description ?? null,
			}
		}

		return infoCache
	}

	return {
		name: HISTORY_SOURCE,

		onInit(context) {
			ctx = context

			return { undo, redo, canUndo, canRedo, getHistoryInfo, clearHistory }
		},

		onCommit(payload) {
			if (index < snapshots.length - 1) {
				snapshots = snapshots.slice(0, index + 1)
			}

			snapshots.push({
				patches: payload.patches,
				inversePatches: payload.inversePatches,
				timestamp: payload.timestamp,
				description: payload.description,
			})
			index++

			if (snapshots.length > maxSize) {
				snapshots.shift()
				index--
			}

			infoCache = null
		},

		onExternalState(_state, meta) {
			// A full replacement (hydration, reset, time travel) makes the patches stale. Patch-level
			// updates only do when they touch keys the stack recorded
			if (!meta.patches || isStaleAfter(meta.patches)) {
				clearStack()
			}
		},

		onDestroy() {
			clearStack()
			ctx = null
		},
	}
}
