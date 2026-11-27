/*
 *   IMPORTS
 ***************************************************************************************************/
import type { Plugin, PluginContext } from '../core'
import { toStoreError } from '../error'
import { hasProtoKey, isStateObject, type Patch } from '../patch'

/*
 *   TYPES
 ***************************************************************************************************/
export interface DevtoolsConfig {
	name?: string
	maxAge?: number
	latency?: number
	features?: {
		jump?: boolean
		skip?: boolean
		import?: boolean
		export?: boolean
	}
}

interface DevtoolsMessage {
	type?: string
	state?: string
	payload?: {
		type?: string
		nextLiftedState?: { computedStates?: { state?: unknown }[] }
	}
}

interface DevtoolsConnection {
	init: (state: unknown) => void
	send: (
		action: { type: string; patches: number },
		state: unknown,
		options: object,
		instanceId: string,
	) => void
	subscribe: (listener: (message: DevtoolsMessage) => void) => () => void
	unsubscribe: () => void
}

interface DevtoolsExtension {
	connect: (config: object) => DevtoolsConnection
}

const DEVTOOLS_SOURCE = 'devtools'
const DEFAULT_NAME = 'Store'
const DEFAULT_MAX_AGE = 50
const DEFAULT_LATENCY_MS = 500

/*
 *   PLUGIN
 ***************************************************************************************************/
export function devtools<T extends object>(config: DevtoolsConfig = {}): Plugin<T> {
	const name = config.name ?? DEFAULT_NAME
	const instanceId = `${name}_${Date.now()}`

	let ctx: PluginContext<T> | null = null
	let connection: DevtoolsConnection | null = null
	let unsubscribe: (() => void) | null = null

	const report = (error: unknown, message: string): void => {
		ctx?.emitError(toStoreError(error, 'DEVTOOLS_FAILED', message), DEVTOOLS_SOURCE)
	}

	const send = (action: string, state: T, patches?: Patch[]): void => {
		try {
			connection?.send({ type: action, patches: patches?.length ?? 0 }, state, {}, instanceId)
		} catch (error) {
			report(error, 'Failed to send action to DevTools')
		}
	}

	// Time travel input is untrusted: it can come from an imported file
	const travel = (state: unknown): void => {
		if (!isStateObject(state) || hasProtoKey(state)) {
			report(new Error('state is not a plain object'), 'Rejected state from DevTools')

			return
		}

		ctx?.replaceState(state as T, {
			source: DEVTOOLS_SOURCE,
			description: 'DevTools time-travel',
		})
	}

	const handleDispatch = (message: DevtoolsMessage): void => {
		try {
			switch (message.payload?.type) {
				case 'JUMP_TO_STATE':
				case 'JUMP_TO_ACTION':
					if (message.state) {
						travel(
							JSON.parse(message.state, (key: string, value: unknown) =>
								key === '__proto__' ? undefined : value,
							),
						)
					}

					break

				case 'IMPORT_STATE': {
					const states = message.payload.nextLiftedState?.computedStates
					const last = states?.[states.length - 1]

					if (last?.state) {
						travel(last.state)
					}

					break
				}
			}
		} catch (error) {
			report(error, 'Failed to handle a DevTools dispatch')
		}
	}

	const connect = (initialState: T): void => {
		if (typeof window === 'undefined') {
			return
		}

		const extension = (window as { __REDUX_DEVTOOLS_EXTENSION__?: DevtoolsExtension })
			.__REDUX_DEVTOOLS_EXTENSION__

		if (!extension) {
			// Not an error: most people don't have the extension installed
			console.warn(
				'[clutch] Redux DevTools Extension not found. Install it from: https://github.com/reduxjs/redux-devtools',
			)

			return
		}

		try {
			connection = extension.connect({
				name,
				instanceId,
				maxAge: config.maxAge ?? DEFAULT_MAX_AGE,
				latency: config.latency ?? DEFAULT_LATENCY_MS,
				features: {
					jump: config.features?.jump ?? true,
					skip: config.features?.skip ?? true,
					import: config.features?.import ?? true,
					export: config.features?.export ?? true,
				},
			})
			unsubscribe = connection.subscribe(message => {
				if (message.type === 'DISPATCH') {
					handleDispatch(message)
				}
			})
			connection.init(initialState)
		} catch (error) {
			connection = null
			report(error, 'Failed to connect to Redux DevTools')
		}
	}

	return {
		name: DEVTOOLS_SOURCE,

		onInit(context) {
			ctx = context
			connect(context.getState())
		},

		onCommit(payload) {
			send(payload.description ?? 'update', payload.state, payload.patches)
		},

		// Undo/redo, hydration and sync all land here. The core skips our own
		// source, so time travel never echoes back to the extension.
		onExternalState(state, meta) {
			send(meta.description ?? `external:${meta.source}`, state, meta.patches)
		},

		onDestroy() {
			unsubscribe?.()
			unsubscribe = null

			try {
				connection?.unsubscribe()
			} catch {
				// Ignore unsubscribe errors
			}

			connection = null
			ctx = null
		},
	}
}
