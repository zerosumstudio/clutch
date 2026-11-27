/*
 *   IMPORTS
 ***************************************************************************************************/
import { StateSyncManager } from '../sync'
import type { ExternalStateMeta, Plugin, PluginContext } from '../core'
import { StoreError, toStoreError } from '../error'
import { diffState } from '../patch'
import type { SyncTransport } from '../transports/types'
import { parseSchema, type StandardSchemaV1 } from './standard-schema'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SyncConfig<T extends object = object> {
	/** Stores that should share state use the same channel. Stamped on every message. */
	channel: string
	/** `state` sends the whole state, `patches` sends changes. */
	mode?: 'state' | 'patches'
	/** Picks what is sent to peers, and the only keys accepted from them. */
	pick?: (state: T) => Partial<T>
	/** Remote updates that fail it are dropped and reported through `onError`. */
	schema?: StandardSchemaV1<T>
	transport?: SyncTransport
	debounceMs?: number
	ignoreLocalChanges?: boolean
	autoStart?: boolean
	maxClockSkewMs?: number
}

export interface SyncApi {
	startSync(): void
}

const SYNC_SOURCE = 'sync'
const DEFAULT_DEBOUNCE_MS = 50
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

/*
 *   PLUGIN
 ***************************************************************************************************/
export function sync<T extends object>(config: SyncConfig<T>): Plugin<T, SyncApi> {
	if (
		typeof (config as Partial<SyncConfig<T>> | undefined)?.channel !== 'string' ||
		config.channel === ''
	) {
		throw new StoreError('Sync requires a channel', 'INVALID_ARGUMENT')
	}

	let ctx: PluginContext<T> | null = null
	let manager: StateSyncManager<T> | null = null

	const startSync = (): void => {
		if (!ctx || manager) {
			return
		}

		const context = ctx

		manager = new StateSyncManager<T>(
			{
				channel: config.channel,
				mode: config.mode ?? 'state',
				debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
				ignoreLocalChanges: config.ignoreLocalChanges ?? false,
				maxClockSkewMs: config.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS,
				pick: config.pick,
				transport: config.transport,
			},
			{
				getState: () => context.getState(),
				onError: error => context.emitError(error, SYNC_SOURCE),
				applyRemote: (state, patches) => {
					if (!config.schema) {
						context.replaceState(state, { source: SYNC_SOURCE, patches })

						return true
					}

					// A schema's output is what gets applied, so keys it strips never get in
					let result
					try {
						result = parseSchema(config.schema, state)
					} catch (error) {
						context.emitError(
							toStoreError(error, 'SYNC_REJECTED', 'Sync dropped a remote update'),
							SYNC_SOURCE,
						)

						return false
					}

					if (!result.ok) {
						context.emitError(
							new StoreError(
								`Sync dropped a remote update that failed the schema: ${result.message}`,
								'SYNC_REJECTED',
								{ cause: result.issues },
							),
							SYNC_SOURCE,
						)

						return false
					}

					const accepted = result.value
					const changes =
						accepted === state
							? patches
							: diffState(context.getState(), accepted).patches

					context.replaceState(accepted, { source: SYNC_SOURCE, patches: changes })

					return true
				},
			},
		)
	}

	return {
		name: SYNC_SOURCE,

		onInit(context) {
			ctx = context

			if (config.autoStart ?? true) {
				startSync()
			}

			return { startSync }
		},

		onCommit(payload) {
			manager?.broadcastChange(payload.patches, payload.description)
		},

		onExternalState(_state, meta: ExternalStateMeta) {
			// Undo and redo travel to peers as patches. Hydration and reset stay local
			if (meta.patches) {
				manager?.broadcastChange(meta.patches, meta.description)
			}
		},

		onDestroy() {
			manager?.destroy()
			manager = null
			ctx = null
		},
	}
}
