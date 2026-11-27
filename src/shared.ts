/*
 *   IMPORTS
 ***************************************************************************************************/
import { version as CLUTCH_VERSION } from '../package.json'
import { isStatefulStore } from './core'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SharedStoreConfig {
	contract?: number | string
	version?: number
	migrate?: (previousState: unknown, fromVersion: number) => unknown
}

interface SharedEntry {
	store: unknown
	clutchVersion: string
	contract: number | string | undefined
	version: number | undefined
}

/*
 *   SHARED STORE
 ***************************************************************************************************/
const REGISTRY_KEY = '__clutchSharedStores'

type SharedScope = typeof globalThis & {
	[REGISTRY_KEY]?: Map<string, SharedEntry>
}

// A Map, so a key like "constructor" is an ordinary name
function getSharedStores(): Map<string, SharedEntry> {
	const scope = globalThis as SharedScope

	return (scope[REGISTRY_KEY] ??= new Map())
}

export function sharedStore<M>(key: string, factory: () => M, config: SharedStoreConfig = {}): M {
	const entries = getSharedStores()
	const existing = entries.get(key)

	if (existing) {
		if (existing.clutchVersion !== CLUTCH_VERSION) {
			console.warn(
				`[clutch] Shared store "${key}" was created by clutch ${existing.clutchVersion}, but this bundle ships clutch ${CLUTCH_VERSION}. Align clutch versions across your apps, or share clutch as a singleton in your module federation config.`,
			)
		}

		reconcile(key, existing, config)

		return existing.store as M
	}

	const store = factory()
	entries.set(key, {
		store,
		clutchVersion: CLUTCH_VERSION,
		contract: config.contract,
		version: config.version,
	})

	return store
}

/*
 *   RECONCILE
 ***************************************************************************************************/
function reconcile(key: string, existing: SharedEntry, config: SharedStoreConfig): void {
	// Version wins when both sides declare one; it can migrate, contract cannot.
	if (config.version !== undefined && existing.version !== undefined) {
		if (config.version > existing.version) {
			migrateUp(key, existing, config)
		} else if (config.version < existing.version) {
			console.warn(
				`[clutch] Shared store "${key}": this app expects version ${config.version}, but the shared state is already at version ${existing.version}. It cannot migrate down and may misread the newer shape.`,
			)
		}

		return
	}

	if (config.contract !== undefined && existing.contract !== config.contract) {
		console.warn(
			`[clutch] Shared store "${key}" contract mismatch: it was created with contract ${String(existing.contract)}, but this app was built against contract ${String(config.contract)}. One of your apps is deployed against a different state shape.`,
		)
	}
}

function migrateUp(key: string, existing: SharedEntry, config: SharedStoreConfig): void {
	const from = existing.version ?? 0

	if (!config.migrate) {
		console.warn(
			`[clutch] Shared store "${key}": a version ${config.version} app joined, but the shared state is version ${from} and no migrate() was provided. It stays on the old shape.`,
		)

		return
	}

	if (!isStatefulStore(existing.store)) {
		return
	}

	try {
		const migrated = config.migrate(existing.store.getState(), from)
		existing.store.replaceState(migrated, {
			source: 'migrate',
			description: `Migrated shared state ${from} -> ${config.version}`,
		})
		existing.version = config.version
		existing.contract = config.contract ?? existing.contract
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		console.warn(
			`[clutch] Shared store "${key}": migrate() from version ${from} to ${config.version} failed; the shared state is unchanged. ${reason}`,
		)
	}
}
