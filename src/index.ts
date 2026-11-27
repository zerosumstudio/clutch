/*
 *   CORE EXPORTS
 ***************************************************************************************************/
export { createStore, shallowEqual } from './core'
export { StoreError } from './error'
export { createRegistry } from './registry'
export { sharedStore } from './shared'

export type {
	Store,
	StoreConfig,
	Plugin,
	PluginContext,
	CommitPayload,
	CommitOptions,
	ExternalStateMeta,
} from './core'

export type { StoreErrorCode } from './error'
export type { Patch } from './patch'
export type { Registry, StoreMap, RegistryState, RegistryListener } from './registry'
export type { SharedStoreConfig } from './shared'

/*
 *   PLUGINS
 ***************************************************************************************************/
export { history } from './plugins/history'
export { persist } from './plugins/persist'
export { devtools } from './plugins/devtools'
export { sync } from './plugins/sync'
export { validate } from './plugins/validate'
export { autosave } from './plugins/autosave'

export type { HistoryApi, HistoryConfig, HistoryInfo } from './plugins/history'
export type { PersistApi, PersistConfig, PersistStorage } from './plugins/persist'
export type { DevtoolsConfig } from './plugins/devtools'
export type { SyncApi, SyncConfig } from './plugins/sync'
export type { StateValidator } from './plugins/validate'
export type { StandardSchemaV1 } from './plugins/standard-schema'
export type { AutosaveApi, AutosaveConfig, AutosaveState } from './plugins/autosave'
export type { SyncTransport, TransportStatus } from './transports/types'
