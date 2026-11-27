# <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zerosumstudio/clutch/main/.github/assets/zerosum-on-dark.png"><img src="https://raw.githubusercontent.com/zerosumstudio/clutch/main/.github/assets/zerosum-on-light.png" alt="" height="32"></picture> Clutch

[![npm version](https://badge.fury.io/js/@zerosumstudio%2Fclutch.svg)](https://badge.fury.io/js/@zerosumstudio%2Fclutch)
[![Release](https://github.com/zerosumstudio/clutch/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/zerosumstudio/clutch/actions/workflows/release.yml)
[![codecov](https://codecov.io/gh/zerosumstudio/clutch/branch/main/graph/badge.svg)](https://codecov.io/gh/zerosumstudio/clutch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A small, TypeScript-first state store with plugins. The core is an immutable store with `set` and `subscribe`, under 2 KB. Undo/redo, persistence, tab and server sync, validation, autosave and DevTools are plugins you add with `.with()`, and each one adds its methods to the store's type. Immer is an optional plugin for mutable-style updates. It is a store, not a state machine: there are no states or transitions.

Coming from `@bkincz/clutch` 3.5? See the [migration guide](./docs/migration-1.0.md).

## Install

```bash
pnpm add @zerosumstudio/clutch
```

Requires Node 26 or newer, and the package is ESM-only. `immer` (`^11.1.16`) is an optional peer, needed only for `@zerosumstudio/clutch/immer`. `react` (`>=18`) is an optional peer, needed only for `@zerosumstudio/clutch/react`.

Up to 3.5.0 this was published as `@bkincz/clutch`.

## Quick start

```ts
import { createStore } from '@zerosumstudio/clutch'

interface AppState {
	count: number
	todos: string[]
}

const store = createStore<AppState>({
	initialState: { count: 0, todos: [] },
})

store.set(state => ({ count: state.count + 1 }))
store.set({ todos: ['Learn clutch'] }, 'Add todo')

store.getState() // { count: 1, todos: ['Learn clutch'] }

const unsubscribe = store.subscribe(state => console.log(state))
```

`set` shallow-merges the keys you pass. For deep, mutable-style updates, add the `immer` plugin:

```bash
pnpm add immer
```

```ts
import { createStore } from '@zerosumstudio/clutch'
import { immer } from '@zerosumstudio/clutch/immer'

const store = createStore<AppState>({
	initialState: { count: 0, todos: [] },
}).with(immer())

store.mutate(draft => {
	draft.count++
	draft.todos.push('Learn clutch')
}, 'Add todo')
```

`mutate` exists only on a store with the plugin, so calling it without `immer()` is a compile error. Recipes are synchronous, and a recipe that changes nothing commits nothing.

## Updating and reading state

State is deeply frozen, including the `initialState` you pass in, so writing to it throws. Updates replace it.

| Method                                    | Description                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `getState()`                              | The current state. Reads are free, it returns the same reference until a change                  |
| `set(partial \| fn, description?)`        | Shallow merge, from a partial or from a function of the current state                            |
| `subscribe(listener)`                     | Runs after every change. Returns an unsubscribe function                                         |
| `subscribe(selector, listener, isEqual?)` | Runs only when the selected value changes, with the next and previous values                     |
| `reset()`                                 | Returns to the initial state. History clears and persisted state is rewritten                    |
| `getInitialState()`                       | The state the store was created with                                                             |
| `replaceState(state, meta?)`              | Replaces the whole state as an external update. The plugin named in `meta.source` isn't notified |
| `with(plugin)`                            | Installs a plugin and returns the store with the plugin's methods added                          |
| `destroy()`                               | Stops every plugin, in reverse install order, and drops listeners                                |

A `set` that changes no top-level key is skipped, and keys are compared with `Object.is`. The optional `description` labels the change in history and DevTools. After `destroy()`, every other method throws a `DESTROYED` error.

```ts
import { shallowEqual } from '@zerosumstudio/clutch'

store.subscribe(
	state => state.count,
	(count, previous) => console.log(previous, '->', count),
)

// A selector that returns a fresh object needs an equality function
store.subscribe(
	state => ({ count: state.count, size: state.todos.length }),
	selected => console.log(selected),
	shallowEqual,
)
```

`shallowEqual` compares objects, arrays, maps and sets one level deep.

A store with plugins records patches for every commit. In a tight loop, like a drag handler, prefer one `set` or one `mutate` recipe per frame over many.

## Plugins

Install plugins with `.with()`. Calling a method from a plugin you never installed is a compile error.

```ts
import { createStore, history, persist } from '@zerosumstudio/clutch'

const store = createStore<AppState>({ initialState: { count: 0, todos: [] } })
	.with(history<AppState>({ maxSize: 50 }))
	.with(persist<AppState>({ key: 'app' }))

store.undo() // from history
void store.flush() // from persist
```

| Plugin       | Import from                   | What it adds                                       |
| ------------ | ----------------------------- | -------------------------------------------------- |
| `immer()`    | `@zerosumstudio/clutch/immer` | `mutate`, for mutable-style updates                |
| `history()`  | `@zerosumstudio/clutch`       | Patch-based undo and redo                          |
| `persist()`  | `@zerosumstudio/clutch`       | Storage persistence with debounced writes          |
| `sync()`     | `@zerosumstudio/clutch`       | State sync across tabs, or through a server        |
| `validate()` | `@zerosumstudio/clutch`       | Rejects commits that fail your validator or schema |
| `autosave()` | `@zerosumstudio/clutch`       | Periodic and manual saving to your server          |
| `devtools()` | `@zerosumstudio/clutch`       | Redux DevTools with time travel, for development   |

Plugin names are unique per store and a plugin's methods can't shadow existing ones. A duplicate throws `DUPLICATE_PLUGIN` and a collision throws `EXTENSION_COLLISION`, both at install time.

Install `persist` before `sync`, so hydration happens before the first sync exchange.

### history

| Option    | Description                                           |
| --------- | ----------------------------------------------------- |
| `maxSize` | Snapshots to keep, a positive integer. Defaults to 50 |

Adds `undo()`, `redo()`, `canUndo()`, `canRedo()`, `getHistoryInfo()` and `clearHistory()`. Undo and redo return `false` when there is nothing to apply, and a new change after an undo drops the redo stack.

`getHistoryInfo()` returns `{ canUndo, canRedo, length, currentIndex, lastDescription }`. The object is the same reference until history changes.

Without `immer()`, patches are per top-level key, so an undo restores the whole previous value of each key the change touched. With it, patches are deep. A full replacement, like hydration, a reset or DevTools time travel, clears the stack. So does a remote update that touches a key the stack recorded.

### persist

```ts
import { persist } from '@zerosumstudio/clutch'

store.with(
	persist<AppState>({
		key: 'app',
		pick: state => ({ count: state.count }),
		schema: persistedSchema,
		version: 2,
		migrate: (stored, fromVersion) => upgrade(stored, fromVersion),
	}),
)
```

| Option       | Description                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `key`        | Required. The storage key                                                                         |
| `pick`       | `state => partialState`. What is stored, and the only keys read back. Everything when omitted     |
| `schema`     | A Standard Schema for the stored state. What it returns is what gets applied                      |
| `storage`    | `getItem`, `setItem` and `removeItem`, each sync or async. Defaults to `localStorage`             |
| `debounceMs` | Delay before a write. Defaults to 300                                                             |
| `maxChars`   | Larger serialized values are not written or read. Defaults to 5 MB (`5 * 1024 * 1024` characters) |
| `autoStart`  | Hydrate on install. Set `false` to call `hydrate()` yourself. Defaults to `true`                  |
| `version`    | Bump it when the stored shape changes. Defaults to 0                                              |
| `migrate`    | `(stored: unknown, fromVersion) => partialState`. Runs when the stored version differs            |

Adds `hydrate(): Promise<boolean>`, `isHydrated()`, `flush(): Promise<void>` and `clearPersisted(): Promise<void>`. State is written on a debounce after every change, and flushed on `pagehide` and `destroy()`. `hydrate()` resolves `true` when stored state was applied.

With `localStorage` or any other sync storage, hydration finishes before `.with()` returns. Keys you change before hydration lands win over the stored ones.

A stored version that differs from `version` goes through `migrate`. Without a `migrate`, the stored value is ignored, reported as `PERSISTENCE_FAILED`, and replaced by the next write. Stored state is untrusted input, so give it a `schema`: a value that fails the schema, or a `migrate` that throws, is reported and not applied, and writes stop so the stored copy isn't overwritten. `reset()` or `clearPersisted()` lifts that.

Browser storage is readable by every script on the origin, so use `pick` to keep tokens and secrets out. With no browser storage, as on a server, the plugin is inert.

#### Async storage

`PersistStorage` methods can return promises, which covers IndexedDB and React Native's AsyncStorage.

```ts
import { createStore, persist, type PersistStorage } from '@zerosumstudio/clutch'

const storage: PersistStorage = {
	getItem: key => db.get(key), // string | null, or a promise of either
	setItem: (key, value) => db.set(key, value),
	removeItem: key => db.delete(key),
}

const store = createStore<AppState>({ initialState: { count: 0, todos: [] } }).with(
	persist<AppState>({ key: 'app', storage }),
)

await store.hydrate() // the read started on install, this waits for it
```

`isHydrated()` is `false` until the read lands. With async storage only one write is in flight at a time and the newest pending write wins, so a slow earlier write can't land last. `flush()` and `clearPersisted()` settle when the storage does.

For server rendering, pass `autoStart: false` and call `hydrate()` after mount, or use `useHydration`.

### sync

`sync` keeps stores in step across tabs with `BroadcastChannel`, or through a server with the WebSocket transport. Every store that should share state uses the same `channel`, and each message carries it, so an unrelated store on the same origin ignores it.

```ts
import { sync } from '@zerosumstudio/clutch'

store.with(
	sync<AppState>({
		channel: 'todos',
		mode: 'patches',
		pick: state => ({ todos: state.todos }),
	}),
)
```

| Option               | Description                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `channel`            | Required. The channel name, the same in every tab and app that should share state                 |
| `mode`               | `state` sends the whole state, `patches` sends changes. Defaults to `state`                       |
| `pick`               | `state => partialState`. What is sent, and the only keys accepted from peers                      |
| `schema`             | A Standard Schema. Remote updates that fail it are dropped and reported as `SYNC_REJECTED`        |
| `transport`          | Your own `SyncTransport` instead of `BroadcastChannel`, like the WebSocket one below              |
| `debounceMs`         | Time to batch outgoing changes. Defaults to 50. A change is sent within ten windows at the latest |
| `ignoreLocalChanges` | Receive only, never send. Defaults to `false`                                                     |
| `maxClockSkewMs`     | Clock difference tolerated on messages without a server version. Defaults to 5 minutes            |
| `autoStart`          | Start on install. Set `false` and call `startSync()` yourself. Defaults to `true`                 |

Adds `startSync()`. Undo and redo are sent to peers. Hydration and `reset()` stay local.

Without a stamping server, concurrent edits resolve to one side's state, the same on every peer, and are not merged. The edit that loses is lost. Put a stamping server in between when edits must merge in order. The ordering rules and the wire format are in [docs/sync-protocol.md](./docs/sync-protocol.md).

With async persistence, pass `autoStart: false` and call `startSync()` after `await store.hydrate()`, so a remote update can't race the stored state.

> **What goes over the wire.** Without `pick`, the whole state is sent, to every same-origin tab over `BroadcastChannel` and to your server and every client in the channel over WebSocket. Use `pick` to keep tokens and other secrets out of what is sent and accepted. Peers are not trusted: remote patches can address any path in the synced state, so give `sync` a `schema` and let the server authorize each channel.

#### WebSocket transport

```ts
import { sync } from '@zerosumstudio/clutch'
import { WebSocketTransport } from '@zerosumstudio/clutch/sync-ws'

store.with(
	sync<AppState>({
		channel: 'todos',
		transport: new WebSocketTransport({
			url: 'wss://example.com/sync',
			getAuthToken: () => getSessionToken(),
		}),
	}),
)
```

The server must implement the stamping relay in [docs/sync-protocol.md](./docs/sync-protocol.md).

| Option                | Description                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `url`                 | Required. The server URL                                                                                                 |
| `getAuthToken`        | Returns the token, sync or async, on every connect                                                                       |
| `authMode`            | `message` sends `{ type: 'auth', token }` as the first frame, `query` appends `?token=`. Defaults to `message`           |
| `protocols`           | Passed to the `WebSocket` constructor                                                                                    |
| `webSocketCtor`       | A `WebSocket` implementation, for Node or tests                                                                          |
| `reconnect`           | `false`, or `{ maxRetries, baseDelayMs, maxDelayMs }`. Defaults to unlimited retries from 500 ms up to 30 s, with jitter |
| `heartbeatIntervalMs` | Ping interval. `0` turns it off. Defaults to 30000                                                                       |
| `heartbeatTimeoutMs`  | Time to wait for a pong before reconnecting. Defaults to 10000                                                           |
| `maxQueueSize`        | Messages kept while offline, oldest dropped first. Defaults to 100                                                       |
| `maxMessageChars`     | Larger inbound frames are dropped before parsing. Defaults to 5 MB                                                       |

`authMode` applies only with `getAuthToken`. Prefer `message`: a token in the URL ends up in server logs and proxies. Transport failures reach the store's `onError` as `SYNC_FAILED`. State sent through a WebSocket must be JSON-serializable.

### validate

Pass a predicate or a Standard Schema.

```ts
import { validate } from '@zerosumstudio/clutch'

store.with(
	validate<AppState>(state => (state.count >= 0 ? true : `count went negative: ${state.count}`)),
)
```

A predicate returns `true`, `false` or a string, which becomes the error message. A failing validator makes `set` and `mutate` throw `VALIDATION_FAILED` before any state is applied. Updates that arrive from outside (sync, hydration, DevTools) are already applied when plugins see them, so those are reported through `onError` instead.

Schemas must be synchronous, since state updates are. An async schema throws `INVALID_ARGUMENT`. The error message lists the failing paths and leaves out the values. The raw issues are on `error.cause`.

### autosave

```ts
import { autosave } from '@zerosumstudio/clutch'

store.with(
	autosave<AppState>({
		save: state => api.put('/state', state),
		load: () => api.get('/state'),
		intervalMs: 60_000,
	}),
)
```

| Option       | Description                                                             |
| ------------ | ----------------------------------------------------------------------- |
| `save`       | Required. Receives the state, sync or async                             |
| `load`       | Returns the server state, or `null` when there is none                  |
| `intervalMs` | Time between saves. Defaults to 5 minutes                               |
| `autoStart`  | Save on the interval when there are unsaved changes. Defaults to `true` |

Adds `save()`, `load()`, `hasUnsavedChanges()` and `getAutosaveState()`.

- `save()` saves what is unsaved, and does nothing when everything is saved. One save runs at a time.
- `load()` replaces the state with what `load` returns and resolves `true`. It resolves `false` when you passed no `load` or it returned `null`.
- Both reject with `AUTOSAVE_FAILED` on failure, and report it through `onError`. A failed save stays unsaved and retries on the next interval.
- `getAutosaveState()` returns `{ status: 'idle' | 'saving' | 'loading', lastSavedAt }`, or `{ status: 'error', error, lastSavedAt }`. It is the same object until the state changes.

Every local change, plus undo, hydration and `reset()`, leaves the saved copy behind. Updates from `sync` and from the plugin's own `load()` don't. With `autoStart: false`, nothing saves until you call `save()`.

### devtools

```ts
import { devtools } from '@zerosumstudio/clutch'

if (isDevelopment) {
	store.with(devtools<AppState>({ name: 'App' }))
}
```

Connects to the [Redux DevTools Extension](https://github.com/reduxjs/redux-devtools). Every commit, undo, sync update and hydration shows up in the timeline, and time travel from the extension updates the store. The plugin adds no methods, so installing it conditionally doesn't change the store's type. Without the extension it logs one warning and does nothing.

| Option     | Description                                                                       |
| ---------- | --------------------------------------------------------------------------------- |
| `name`     | Instance name in the extension. Defaults to `Store`                               |
| `maxAge`   | Maximum actions kept in the timeline. Defaults to 50                              |
| `latency`  | Passed to the extension. Defaults to 500                                          |
| `features` | `{ jump, skip, import, export }` toggles for the extension. All default to `true` |

Keep it out of production. It sends the full state of every action to the extension, and anyone with the extension open can replace your store's state through time travel or import. States it receives that aren't plain objects, or carry a `__proto__` key, are rejected.

## Registry

Group stores and read them as one combined state.

```ts
import { createRegistry, createStore, history, persist } from '@zerosumstudio/clutch'

const registry = createRegistry({
	user: createStore<UserState>({ initialState: { name: '' } }).with(history<UserState>()),
	cart: createStore<CartState>({ initialState: { items: [] } }).with(
		persist<CartState>({ key: 'cart' }),
	),
})

registry.getState() // { user: UserState, cart: CartState }
registry.subscribe(combined => console.log(combined))

registry.stores.user.undo() // plugin methods are preserved per store
```

`resetAll()` resets every store and `destroyAll()` destroys them. For anything else, loop over `registry.stores`, for example `await registry.stores.doc.save()`. The store map is fixed at creation.

## One store across bundles

`sharedStore` creates a store once per page and returns the same instance to every caller of the same key, whichever bundle the call comes from.

```ts
import { createStore, persist, sharedStore } from '@zerosumstudio/clutch'

export const playerStore = sharedStore('app:player', () =>
	createStore<PlayerState>({ initialState: { track: null } }).with(
		persist<PlayerState>({ key: 'player' }),
	),
)
```

Each app keeps its own copy of this module and they all end up on one store. The registry lives on `globalThis` as `__clutchSharedStores` and instances are used structurally, so it works even when apps bundle separate copies of clutch. With Module Federation, share clutch as a singleton so only one copy loads:

```jsonc
// the shared option of your federation plugin
"shared": ["react", "react-dom", "@zerosumstudio/clutch", "@zerosumstudio/clutch/react"]
```

Independent deployments can disagree on the state shape. Pass a `contract` and clutch warns at runtime when two apps differ, naming the key and both values. Mismatched clutch versions across bundles get the same warning.

For a shape change that should migrate rather than warn, pass a numeric `version` and a `migrate`. When an app with a higher `version` joins, `migrate(previousState, fromVersion)` upgrades the shared state in place. `version` takes precedence over `contract` when both sides declare one.

```ts
sharedStore('app:player', factory, {
	version: 2,
	migrate: (previous, from) => upgrade(previous, from),
})
```

A lower `version` than the shared state, a missing `migrate` and a `migrate` that throws each warn and leave the state alone.

Micro frontends in separate iframes or tabs have no shared page to share an instance on. Use the `sync` plugin, whose `BroadcastChannel` transport keeps same-origin stores in step.

## React

Hooks live in `@zerosumstudio/clutch/react`. The main entry stays React-free. They need React 18 or newer.

```tsx
import { shallowEqual } from '@zerosumstudio/clutch'
import { useStore } from '@zerosumstudio/clutch/react'

function Counter() {
	// re-renders only when the selected value changes
	const count = useStore(store, state => state.count)

	return <button onClick={() => store.set(state => ({ count: state.count + 1 }))}>{count}</button>
}

function Summary() {
	// a selector that returns a fresh object needs an equality function
	const { count, size } = useStore(
		store,
		state => ({ count: state.count, size: state.todos.length }),
		shallowEqual,
	)

	return (
		<span>
			{count} / {size}
		</span>
	)
}
```

| Hook                                         | Needs             | Returns                                                                 |
| -------------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `useStore(store)`                            | core              | The whole state                                                         |
| `useStore(store, selector, isEqual?)`        | core              | The selected value                                                      |
| `useSubscription(store, callback)`           | core              | Nothing, runs your callback on changes                                  |
| `useRegistry(registry, selector?, isEqual?)` | registry          | The combined state, or the selected value                               |
| `useHistory(store)`                          | `history` plugin  | `getHistoryInfo()` fields plus `undo`, `redo` and `clearHistory`        |
| `useHydration(store)`                        | `persist` plugin  | `{ isHydrated }`, and calls `hydrate()` on mount                        |
| `useAutosave(store)`                         | `autosave` plugin | `getAutosaveState()` fields, `hasUnsavedChanges`, `save()` and `load()` |
| `createStoreScope(factory, name?)`           | core              | `{ Provider, useScopedStore }`, one store per provider                  |

The plugin hooks require the plugin's methods on the store's type, so passing a store without that plugin fails to compile.

`useAutosave().save()` and `.load()` resolve `true` or `false` and never reject. Read the failure from `status` and `error`.

```tsx
import { useAutosave } from '@zerosumstudio/clutch/react'

function SaveButton() {
	const { status, hasUnsavedChanges, save } = useAutosave(store)

	return (
		<button disabled={!hasUnsavedChanges || status === 'saving'} onClick={() => void save()}>
			{status === 'error' ? 'Retry' : 'Save'}
		</button>
	)
}
```

### Request-scoped stores

A module-level store is one object per process. On a server, every concurrent request renders against the same instance, so one user's data can reach another user's render. `autoStart: false` doesn't help, because this isn't a persistence problem. Build the store per render tree with `createStoreScope(factory, name?)`, which returns a `Provider` that builds one store per mount and a hook that reads it.

```tsx
import type { ReactNode } from 'react'
import { createStore } from '@zerosumstudio/clutch'
import { createStoreScope, useStore } from '@zerosumstudio/clutch/react'

interface UserState {
	details: { name: string } | null
}

const { Provider: UserProvider, useScopedStore: useUserStore } = createStoreScope(
	() => createStore<UserState>({ initialState: { details: null } }),
	'User',
)

// server component, userDetails differ per request
export default async function Layout({ children }: { children: ReactNode }) {
	const userDetails = await getUserDetails()

	return <UserProvider state={{ details: userDetails }}>{children}</UserProvider>
}

// any client component below it
function Greeting() {
	const store = useUserStore()
	const name = useStore(store, state => state.details?.name ?? '')

	return <span>{name}</span>
}
```

`state` is merged in before the first render, so children never see an empty store, and again whenever it changes by value. A parent re-render that rebuilds an equal object doesn't re-seed, so writes made in between survive. `name` sets the context display name and appears in the error thrown when the hook runs outside its provider.

The provider destroys its store when it unmounts, which stops the plugins' timers, listeners and channels. Use a scope only for data that belongs to a single request. Client-only state like UI preferences is fine on a module-level store.

## Handling errors

Everything clutch raises is a `StoreError` with a `code`. Errors are not subclassed, so check `error.code`.

```ts
import { StoreError } from '@zerosumstudio/clutch'

try {
	store.set({ count: -1 })
} catch (error) {
	if (error instanceof StoreError && error.code === 'VALIDATION_FAILED') {
		showMessage(error.message)
	}
}
```

Misuse and vetoes throw to the caller. Failures that happen away from a call, like a storage write, a sync message or a plugin hook, are reported to the `onError(error, operation)` hook of every installed plugin instead. With no `onError` installed they go to `console.error`. To monitor them, install a plugin that has one:

```ts
store.with({
	name: 'error-reporter',
	onError: (error, operation) => report({ code: error.code, operation }),
})
```

`operation` is the plugin that reported (`persist`, `sync`, `autosave`, `devtools` or `validate`), `plugin:<name>:<hook>` for a plugin hook that threw, or `undo`, `redo` and `notify`.

| `StoreErrorCode`      | Raised when                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`    | An argument or config is wrong, or a patch is malformed. Thrown                                                 |
| `VALIDATION_FAILED`   | A `validate` predicate or schema vetoed a change. Thrown from `set` and `mutate`, reported for external updates |
| `PATCH_CONFLICT`      | A patch no longer fits the state. `sync` answers it with a resync and doesn't report it                         |
| `DESTROYED`           | A destroyed store or registry was used. Thrown                                                                  |
| `DUPLICATE_PLUGIN`    | A plugin name is installed twice. Thrown                                                                        |
| `EXTENSION_COLLISION` | A plugin's method collides with an existing member. Thrown                                                      |
| `PERSISTENCE_FAILED`  | A read, write, migration or schema check failed in `persist`. Reported                                          |
| `AUTOSAVE_FAILED`     | A save or load failed. Rejected by `save()` and `load()`, and reported                                          |
| `SYNC_REJECTED`       | An inbound sync message was refused: bad shape, failed `schema`, clock skew. Reported                           |
| `SYNC_FAILED`         | The transport or a send failed. Reported                                                                        |
| `DEVTOOLS_FAILED`     | The extension failed to connect or send, or sent a state clutch rejected. Reported                              |
| `PLUGIN_FAILED`       | A plugin hook or listener threw, or an undo or redo failed. Reported, with the original on `cause`              |

## Writing a plugin

A plugin is an object with a name and lifecycle hooks. Whatever `onInit` returns is merged onto the store and shows up in its type.

```ts
import { createStore, type Plugin } from '@zerosumstudio/clutch'

function logger<T extends object>(): Plugin<T, { getLogCount(): number }> {
	let count = 0

	return {
		name: 'logger',
		onInit: () => ({ getLogCount: () => count }),
		onCommit: payload => {
			count++
			console.log(payload.description ?? 'update', payload.patches)
		},
	}
}

const store = createStore<AppState>({ initialState }).with(logger())
store.getLogCount()
```

| Hook                           | When it runs                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onInit(ctx)`                  | At install. Return an object to extend the store. `ctx` has `getState`, `commit`, `replaceState`, `applyPatches`, `subscribe`, `notify` and `emitError`                       |
| `onBeforeCommit(payload)`      | Before a local change is applied. Throw to reject it                                                                                                                          |
| `onCommit(payload)`            | After a local change is applied, before subscribers are notified. The payload has `state`, `patches`, `inversePatches`, `description` and `timestamp`                         |
| `onExternalState(state, meta)` | When state changes outside `set` and `mutate`: sync updates, hydration, undo, time travel, reset. `meta.source` names the plugin that caused it, and that plugin isn't called |
| `onError(error, operation)`    | When any plugin reports an error                                                                                                                                              |
| `onDestroy(finalState)`        | On `store.destroy()`, in reverse install order                                                                                                                                |

`ctx.commit(state, { patches?, inversePatches?, description? })` is how a plugin makes a local change. It runs `onBeforeCommit`, applies the state and runs `onCommit`. Without `patches`, the top-level keys are diffed. `ctx.replaceState` and `ctx.applyPatches` make external changes, and `ctx.notify()` publishes a change a plugin exposes through its own API without touching state.

An error thrown from `onCommit`, `onExternalState`, `onDestroy` or a subscriber doesn't stop the others. It is reported as `PLUGIN_FAILED`.

## Size

Minified and brotli compressed, including dependencies, from `pnpm size`. Plugins you don't import are tree-shaken away.

| Import                           | Size                                  |
| -------------------------------- | ------------------------------------- |
| `{ createStore }` only           | 1.89 KB                               |
| `{ createStore }` + `immer()`    | 2.02 KB, plus immer (4.45 KB, a peer) |
| Everything from the main entry   | 8.13 KB                               |
| React hooks (`/react`)           | 1.41 KB                               |
| WebSocket transport (`/sync-ws`) | 1.19 KB                               |

## TypeScript

State types are inferred from `initialState`, or pass them explicitly with `createStore<AppState>(...)`. Each `.with()` widens the store's type with the plugin's API.

```ts
import { createStore, history } from '@zerosumstudio/clutch'

const store = createStore<AppState>({ initialState }).with(history<AppState>())

store.undo() // ok
store.hydrate() // compile error, persist is not installed
```

Every plugin's API and config type is exported, so a plugin-extended store has a name:

```ts
import type { HistoryApi, PersistApi, Store } from '@zerosumstudio/clutch'

type AppStore = Store<AppState> & HistoryApi & PersistApi
```

Also exported: `StoreConfig`, `Plugin`, `PluginContext`, `CommitPayload`, `CommitOptions`, `ExternalStateMeta`, `Patch`, `StoreErrorCode`, `StandardSchemaV1`, `SyncTransport`, `TransportStatus`, `Registry`, `StoreMap`, `RegistryState` and `SharedStoreConfig`. `Draft` and `ImmerApi` come from `@zerosumstudio/clutch/immer`.

## Upgrading to 1.0

1.0 is the first release under `@zerosumstudio`. Coming from `@bkincz/clutch` 3.5, the machine becomes a store, immer becomes a plugin, `batch` and the registry helpers are gone, and several options are renamed. The [migration guide](./docs/migration-1.0.md) opens with a search-and-replace checklist and covers every change with a before and after. The full list is in the [changelog](./CHANGELOG.md).

## License

MIT © zerosum studio
