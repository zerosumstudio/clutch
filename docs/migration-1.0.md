# Migrating from `@bkincz/clutch` 3.5 to `@zerosumstudio/clutch` 1.0

1.0 is the first release under `@zerosumstudio`. It renames machines to stores, makes immer an optional plugin, and trims and renames several options. There is no compatibility layer, so every change below is yours to make. Most are mechanical.

This guide covers `@bkincz/clutch` 3.5.0. Older versions need the 3.5 changes first.

## Search-and-replace checklist

Run these over your source in order, whole word, then fix the few that need a hand edit.

| Find                              | Replace with                              | Notes                                                             |
| --------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| `@bkincz/clutch`                  | `@zerosumstudio/clutch`                   | `package.json`, imports, bundler `shared` config                  |
| `createMachineScope`              | `createStoreScope`                        |                                                                   |
| `useScopedMachine`                | `useScopedStore`                          |                                                                   |
| `sharedMachine`                   | `sharedStore`                             |                                                                   |
| `createMachine`                   | `createStore`                             |                                                                   |
| `MachineError`                    | `StoreError`                              | Check `error.code` instead of `instanceof` on a subclass          |
| `MachineConfig`, `MachineMap`     | `StoreConfig`, `StoreMap`                 |                                                                   |
| `SharedMachineOptions`            | `SharedStoreConfig`                       |                                                                   |
| `Machine<`                        | `Store<`                                  | Type position only. Never construct it with `new`                 |
| `registry.machines`               | `registry.stores`                         |                                                                   |
| `useSlice(`                       | `useStore(`                               | Same arguments. This is the bulk of most apps                     |
| `useRegistrySlice(`               | `useRegistry(`                            | Same arguments                                                    |
| `useMachineHistory(`              | `useHistory(`                             | `historyLength` is `length`, `lastAction` is `lastDescription`    |
| `useMachine(`                     | `useStore(`                               | Does not return `{ state, mutate }` any more, see [React](#react) |
| `filter:` in `persist`            | `pick:`                                   | Rewrite the value, see [persist](#persist)                        |
| `deferred: true`                  | `autoStart: false`                        | `deferred: false` is the default and can go                       |
| `auto: false` in `autosave`       | `autoStart: false`                        |                                                                   |
| `mergeStrategy: 'latest'`         | `mode: 'state'`                           | `'patches'` stays `'patches'`                                     |
| `syncDebounce`                    | `debounceMs`                              |                                                                   |
| `forceSave(`                      | `save(`                                   |                                                                   |
| `loadFromServer(`                 | `load(`                                   |                                                                   |
| `VALIDATION_ERROR`                | `VALIDATION_FAILED` or `INVALID_ARGUMENT` | See [error codes](#error-codes)                                   |
| `PERSISTENCE_ERROR` from autosave | `AUTOSAVE_FAILED`                         |                                                                   |

Then add what has no search pattern:

1. Add `.with(immer())` to every store that calls `mutate`, and `pnpm add immer`. The `mutate` call sites don't change.
2. Give every `sync()` a `channel`.
3. Replace `batch(...)` calls, and add `await` where `hydrate()` result is used, as described below.
4. Run the type checker. Most of what is left shows up as a compile error.

## Package and runtime

| 3.5                                  | 1.0                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `@bkincz/clutch`                     | `@zerosumstudio/clutch`. `@bkincz/clutch` stays on npm at 3.5.0                             |
| ESM and CommonJS                     | ESM only. `require()` of the package works on Node 26                                       |
| Node 22.12 or newer                  | Node 26 or newer (`engines.node` is `>=26`)                                                 |
| React 16.8 or newer (peer)           | React 18 or newer (peer, optional). The hooks already relied on 18's `useSyncExternalStore` |
| `immer` a dependency                 | `immer` an optional peer (`^11.1.16`), needed only for the `/immer` entry                   |
| `use-sync-external-store` dependency | Removed                                                                                     |

Jest setups that transform to CommonJS need `transformIgnorePatterns` to let the package through.

The entries are `@zerosumstudio/clutch`, `/react`, `/immer` and `/sync-ws`.

## Machine becomes store

Clutch has no states or transitions, so the API says store. These are the renames from the checklist, in one place:

| 3.5                                         | 1.0                                            |
| ------------------------------------------- | ---------------------------------------------- |
| `createMachine`, `Machine`, `MachineConfig` | `createStore`, `Store`, `StoreConfig`          |
| `MachineError`                              | `StoreError`, with `StoreErrorCode` for `code` |
| `sharedMachine`, `SharedMachineOptions`     | `sharedStore`, `SharedStoreConfig`             |
| `globalThis.__clutchSharedMachines`         | `globalThis.__clutchSharedStores`              |
| `createMachineScope`, `useScopedMachine`    | `createStoreScope`, `useScopedStore`           |
| `registry.machines`, `MachineMap`           | `registry.stores`, `StoreMap`                  |
| `devtools()` default name `Machine`         | `Store`                                        |
| Log prefixes `[Store]`, `[Clutch]`          | `[clutch]`                                     |

`StoreError` is a class you can `instanceof`, but it isn't subclassed. Branch on `error.code`.

Two copies of clutch on one page no longer share `sharedStore` entries with a 3.5 bundle, since the global key changed. Move every app together.

## Immer is a plugin

Immer is no longer a dependency. The core updates with `set`, and `mutate` comes from the `immer()` plugin.

```ts
// before
import { createMachine } from '@bkincz/clutch'

const machine = createMachine<AppState>({ initialState })

machine.mutate(draft => {
	draft.count++
})
```

```ts
// after: pnpm add immer
import { createStore } from '@zerosumstudio/clutch'
import { immer } from '@zerosumstudio/clutch/immer'

const store = createStore<AppState>({ initialState }).with(immer())

store.mutate(draft => {
	draft.count++
})
```

- `mutate` exists only on a store with the plugin. Without it, calling `mutate` is a compile error and `undefined` at runtime.
- `Draft` is exported from `@zerosumstudio/clutch/immer`, not the main entry. `Patch` is exported from the main entry and is clutch's own type with the same shape.
- A recipe must be synchronous. A recipe that changes nothing commits nothing.
- A store that never needs deep updates can drop immer. `set` now takes a function too, so `store.set(state => ({ count: state.count + 1 }))` replaces the simple recipes.
- `history` and `sync` in `patches` mode work without immer, at top-level key granularity. An undo restores the whole previous value of each key that changed. With `immer()` they stay deep.
- State is deeply frozen, including the `initialState` you pass in. That was already true for immer's output, and now it holds for `set`, hydration and sync too.

## `batch` is removed

One `mutate` recipe already commits once, so move the recipes into one.

```ts
// before
machine.batch([draft => void draft.count++, draft => void draft.todos.push('Ship it')], 'Add todo')
```

```ts
// after
store.mutate(draft => {
	draft.count++
	draft.todos.push('Ship it')
}, 'Add todo')

// or, without immer
store.set(state => ({ count: state.count + 1, todos: [...state.todos, 'Ship it'] }), 'Add todo')
```

## React

Hooks need React 18 or newer. One hook reads one source, and the selector is optional.

| 3.5                                                             | 1.0                                         |
| --------------------------------------------------------------- | ------------------------------------------- |
| `useMachine(machine)` returning `{ state, mutate, batch }`      | `useStore(store)` returning the state       |
| `useSlice(machine, selector, equalityFn?)`                      | `useStore(store, selector, isEqual?)`       |
| `useRegistrySlice(registry, selector, equalityFn?)`             | `useRegistry(registry, selector, isEqual?)` |
| `useMachineHistory(machine)`                                    | `useHistory(store)`                         |
| `createMachineScope(factory, name?)`                            | `createStoreScope(factory, name?)`          |
| `useSubscription`, `useHydration`, `useRegistry`, `useAutosave` | Same names, see below                       |

`useMachine` returned `mutate` and `batch`. Call the store directly instead.

```tsx
// before
const { state, mutate } = useMachine(machine)

mutate(draft => {
	draft.count++
})
```

```tsx
// after
import { useStore } from '@zerosumstudio/clutch/react'

const state = useStore(store)

store.mutate(draft => {
	draft.count++
})
```

A selector that returns a fresh object needs an equality function. `shallowEqual` is exported from the main entry:

```tsx
// after
import { shallowEqual } from '@zerosumstudio/clutch'
import { useStore } from '@zerosumstudio/clutch/react'

const { count, size } = useStore(
	store,
	state => ({ count: state.count, size: state.todos.length }),
	shallowEqual,
)
```

`useHistory` returns `{ canUndo, canRedo, length, currentIndex, lastDescription, undo, redo, clearHistory }`. The two renamed fields are `historyLength` to `length` and `lastAction` to `lastDescription`.

`useAutosave` reads one status from the plugin instead of keeping its own flags per component, so two components can't disagree.

```tsx
// before
const {
	isSaving,
	isLoading,
	lastSaved,
	saveError,
	loadError,
	hasUnsavedChanges,
	save,
	clearSaveError,
} = useAutosave(machine)
```

```tsx
// after
import { useAutosave } from '@zerosumstudio/clutch/react'

const autosaveState = useAutosave(store)

autosaveState.status // 'idle' | 'saving' | 'loading' | 'error'
autosaveState.lastSavedAt // a timestamp in milliseconds, or null

if (autosaveState.status === 'error') {
	autosaveState.error // a StoreError
}
```

| 3.5                                | 1.0                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `isSaving`, `isLoading`            | `status === 'saving'`, `status === 'loading'`                                           |
| `saveError`, `loadError` (strings) | `status === 'error'` with `error` (a `StoreError`). Don't show `error.message` to users |
| `lastSaved` (a `Date`)             | `lastSavedAt` (a number, or `null`)                                                     |
| `clearSaveError`, `clearLoadError` | Removed. The next save or load clears the error                                         |
| `save()`, `load()`                 | Kept. Resolve `true` or `false` and never reject                                        |

`useHydration` is unchanged: it returns `{ isHydrated }` and hydrates on mount.

`createStoreScope` also destroys its store when the provider unmounts, so a scoped store with `persist` or `sync` no longer leaks its listeners.

## persist

### `filter` is `pick`

`pick` returns the part of the state to store. It also limits which keys are read back.

```ts
// before
persist<AppState>({ key: 'app', filter: { include: ['count'] } })
persist<AppState>({ key: 'app', filter: { exclude: ['draft'] } })
persist<AppState>({ key: 'app', filter: { custom: state => ({ count: state.count }) } })
```

```ts
// after
persist<AppState>({ key: 'app', pick: state => ({ count: state.count }) })
persist<AppState>({ key: 'app', pick: ({ draft, ...rest }) => rest })
```

The storage format is unchanged, so stored data needs no migration.

### `deferred` is `autoStart`

```ts
// before
persist<AppState>({ key: 'app', deferred: true })
```

```ts
// after
persist<AppState>({ key: 'app', autoStart: false })
```

### `hydrate()` returns a promise

Storage can now be async, so `hydrate()`, `flush()` and `clearPersisted()` return promises. `hydrate()` resolves `true` when stored state was applied.

```ts
// before
if (machine.hydrate()) {
	showWelcomeBack()
}
```

```ts
// after
if (await store.hydrate()) {
	showWelcomeBack()
}
```

A call site that still tests the result without `await` sees a truthy promise, so look for `hydrate()` in conditions. With `localStorage` or another sync storage, hydration still finishes before `.with()` returns, so `isHydrated()` is `true` right after install.

`PersistStorage` methods may return promises, which covers IndexedDB and React Native's AsyncStorage. With async storage, `await store.hydrate()` before starting `sync`.

### `migrate` and `schema`

`migrate` now receives `unknown`, since stored data is untrusted:

```ts
// before
migrate: (persisted: Partial<AppState>, fromVersion: number) => upgrade(persisted, fromVersion)
```

```ts
// after
migrate: (stored: unknown, fromVersion: number) => upgrade(stored, fromVersion)
```

New `schema` option: a Standard Schema that checks the stored state after `migrate`. A value that fails it is reported as `PERSISTENCE_FAILED` and not applied, and writes stop so the stored copy isn't overwritten.

## sync

### `channel` is required

3.5 defaulted every store to one channel, `clutch-state-sync`, so every store on an origin copied every other. Pick a channel on purpose, the same in every tab and app that should share state. `sync()` with no config, or one without a `channel`, fails to compile and throws `INVALID_ARGUMENT`.

```ts
// before
sync<AppState>({ mergeStrategy: 'latest', syncDebounce: 50 })
```

```ts
// after
sync<AppState>({ channel: 'todos', mode: 'state', debounceMs: 50 })
```

| 3.5                                    | 1.0                                                    |
| -------------------------------------- | ------------------------------------------------------ |
| `channel`, default `clutch-state-sync` | `channel`, required                                    |
| `mergeStrategy: 'latest' \| 'patches'` | `mode: 'state' \| 'patches'`, default `'state'`        |
| `syncDebounce`                         | `debounceMs`                                           |
| Sends the whole state                  | `pick` limits what is sent and which keys are accepted |

Every message now carries its `channel`, and a store ignores messages for another channel. A tab still running 3.5 and one running 1.0 do not sync with each other, so roll out together.

`BroadcastChannelTransport` is no longer exported. The `channel` option is its only setting, and `sync` takes it.

### `pick` keeps secrets off the wire

Without `pick`, the whole state, tokens included, goes to every tab and to the server. Add one for any store that holds a session token or other secret:

```ts
// after
sync<AppState>({
	channel: 'todos',
	pick: state => ({ todos: state.todos }),
})
```

### Wire format

For anyone running their own WebSocket server:

- Messages carry a `channel` field. Relay it unchanged.
- Messages no longer carry `inversePatches`.
- `timestamp` is a logical clock stamp that clients use to order messages the server didn't version. The server keeps stamping `version` as before.
- The protocol now also requires the server to overwrite `version` on every message, bind `instanceId` to the socket, and relay nothing to or from a socket that hasn't authenticated.

All of it is in [sync-protocol.md](./sync-protocol.md).

### WebSocket `authMode` defaults to `message`

3.5 put the token in the URL query. 1.0 sends it as the first frame instead, which keeps it out of server logs.

```ts
// before: query string by default
new WebSocketTransport({ url: 'wss://example.com/sync', getAuthToken })
```

```ts
// after: the first frame is { "type": "auth", "token": "..." }
new WebSocketTransport({ url: 'wss://example.com/sync', getAuthToken })

// keep the old behaviour
new WebSocketTransport({ url: 'wss://example.com/sync', getAuthToken, authMode: 'query' })
```

The server has to accept the `auth` frame, or you set `authMode: 'query'` until it does.

`WebSocketTransport` no longer takes an `onError` option. Its errors reach the store's `onError` as `SYNC_FAILED`, in one place. It also drops inbound frames over `maxMessageChars` (5 MB by default).

### Behaviour changes

- Concurrent edits from different tabs now settle on one winner, the same on every tab. Peers order messages by `(timestamp, instanceId)` from a logical clock.
- Sync updates keep the history stack when they don't touch a key the stack recorded. 3.5 cleared it on a remote update in `state` mode.
- Undo and redo are sent to peers. Hydration and `reset()` stay local.

## autosave

The API names the action, and the status lives in the plugin.

```ts
// before
autosave<AppState>({ save, load, intervalMs: 60_000, auto: false })
await machine.forceSave()
await machine.loadFromServer()
machine.setAutoSaveInterval(10_000)
```

```ts
// after
autosave<AppState>({ save, load, intervalMs: 60_000, autoStart: false })
await store.save()
await store.load()
store.getAutosaveState() // { status: 'idle', lastSavedAt: null }
```

| 3.5                       | 1.0                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `auto: false`             | `autoStart: false`                                                                       |
| `forceSave()`             | `save()`                                                                                 |
| `loadFromServer()`        | `load()`                                                                                 |
| `setAutoSaveInterval(ms)` | Removed. `intervalMs` is config only                                                     |
| (none)                    | `getAutosaveState()`: `{ status, lastSavedAt }`, plus `error` when `status` is `'error'` |
| `hasUnsavedChanges()`     | Same                                                                                     |

What changes in behaviour:

- `load()` rejects with `AUTOSAVE_FAILED` when `load` throws, like `save()`. `loadFromServer()` resolved `false` and reported the error.
- Failures are reported under the `autosave` operation. 3.5 reported them as `PERSISTENCE_ERROR` under `persist`.
- Undo, hydration and `reset()` now count as unsaved changes. In 3.5 only local mutations did. Updates from `sync` and from the plugin's own `load()` still don't.
- The interval timer starts without a `window` too, so it also runs on a server. It never keeps a Node process alive.

## Registry helpers are removed

`createRegistry` keeps `stores`, `getState`, `subscribe`, `resetAll` and `destroyAll`. The other coordination helpers were each a loop over the stores, so write the loop.

```ts
// before
await registry.hydrateAll()
await registry.forceSaveAll()
registry.clearAllHistory()
```

```ts
// after
await Promise.all([registry.stores.user.hydrate(), registry.stores.cart.hydrate()])
await registry.stores.doc.save()
registry.stores.user.clearHistory()
```

The removed helpers are `hydrateAll`, `flushAll`, `forceSaveAll`, `hasUnsavedChanges` and `clearAllHistory`. Loop over the stores that have the plugin, since a store without it has no such method.

## Classes are types only

`Store` and `Registry` are exported as types. Construct them with `createStore` and `createRegistry`. `StoreError` is still a value.

```ts
// before
const machine = new Machine({ initialState })
```

```ts
// after
const store = createStore({ initialState })
```

## Error codes

Codes lose the `_ERROR` suffix and each has one meaning. `StoreError.code` is typed as `StoreErrorCode`, not `string`.

| 3.5                                                    | 1.0                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` for a bad argument or config        | `INVALID_ARGUMENT`                                                                                   |
| `VALIDATION_ERROR` for a `validate` veto               | `VALIDATION_FAILED`                                                                                  |
| `VALIDATION_ERROR` for a patch that doesn't fit        | `PATCH_CONFLICT`. `sync` answers it with a resync and doesn't report it                              |
| `PERSISTENCE_ERROR`                                    | `PERSISTENCE_FAILED` for `persist`, `AUTOSAVE_FAILED` for `autosave`                                 |
| `DESTROYED`, `DUPLICATE_PLUGIN`, `EXTENSION_COLLISION` | Same                                                                                                 |
| (sync problems were logged to the console)             | `SYNC_REJECTED` for a refused message, `SYNC_FAILED` for a transport failure, both through `onError` |
| (devtools problems were logged)                        | `DEVTOOLS_FAILED`                                                                                    |
| (plugin errors)                                        | `PLUGIN_FAILED` for a hook or listener that threw                                                    |

Sync, transport and DevTools problems that 3.5 only logged now reach `onError`, so an app can monitor them. With no plugin that has an `onError`, they go to `console.error`.

## Types

| 3.5                                                                                                                             | 1.0                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `Draft`, `Patch` from the main entry                                                                                            | `Patch` from the main entry, `Draft` from `/immer` |
| `SyncPluginConfig`                                                                                                              | `SyncConfig`                                       |
| `DevToolsConfig`                                                                                                                | `DevtoolsConfig`                                   |
| `EmptyExtension`, `HistorySnapshot`, `PersistedEnvelope`, `PersistFilter`, `CommitOperation`, `BroadcastChannelTransportConfig` | Removed                                            |
| `CommitPayload.operation`                                                                                                       | Removed                                            |
| `HistoryInfo.historyLength`, `lastAction`                                                                                       | `length`, `lastDescription`                        |
| `MachineError.code: string`                                                                                                     | `StoreError.code: StoreErrorCode`                  |

New exports: `shallowEqual`, `StoreErrorCode`, `CommitOptions`, `AutosaveState`, `ImmerApi` (from `/immer`) and `AutosaveHookState`, `HistoryState` and `HydrationState` (from `/react`).

Plugin API types are exported, so a plugin-extended store can be named without `ReturnType`:

```ts
// after
import type { HistoryApi, PersistApi, Store } from '@zerosumstudio/clutch'

type AppStore = Store<AppState> & HistoryApi & PersistApi
```

## Plugin authors

- A local change goes through `ctx.commit(state, { patches?, inversePatches?, description? })`. It runs `onBeforeCommit`, applies the state and runs `onCommit`. Without `patches` the top-level keys are diffed. 3.5 plugins had no way to commit.
- `onError` and `ctx.emitError` take a `StoreError`, not an `Error`. Wrap with `new StoreError(message, code)`.
- `CommitPayload.operation` is gone. Use `description`.
- An error thrown from a hook or listener is reported as `PLUGIN_FAILED`.

```ts
// after
import { StoreError, type Plugin } from '@zerosumstudio/clutch'

function limit<T extends object>(max: number): Plugin<T> {
	return {
		name: 'limit',
		onBeforeCommit: payload => {
			if (JSON.stringify(payload.state).length > max) {
				throw new StoreError('State is too large', 'VALIDATION_FAILED')
			}
		},
	}
}
```
