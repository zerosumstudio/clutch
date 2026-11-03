# <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zerosumstudio/clutch/main/.github/assets/zerosum-on-dark.png"><img src="https://raw.githubusercontent.com/zerosumstudio/clutch/main/.github/assets/zerosum-on-light.png" alt="" height="32"></picture> Clutch

[![npm version](https://badge.fury.io/js/@zerosumstudio%2Fclutch.svg)](https://badge.fury.io/js/@zerosumstudio%2Fclutch)
[![Release](https://github.com/zerosumstudio/clutch/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/zerosumstudio/clutch/actions/workflows/release.yml)
[![codecov](https://codecov.io/gh/zerosumstudio/clutch/branch/main/graph/badge.svg)](https://codecov.io/gh/zerosumstudio/clutch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A TypeScript-first, plugin-based state manager built on Immer. The core does immutable updates and subscriptions. Undo/redo, persistence, sync and DevTools are plugins you opt into, and each one adds its methods to the machine's type, so you only ship and see what you install.

Coming from v2? See the [migration guide](./docs/migration-v3.md).

## Install

```bash
pnpm add @zerosumstudio/clutch
```

Requires Node 22.12 or newer. React 16.8+ is an optional peer, needed only for `@zerosumstudio/clutch/react`.

Up to 3.5.0 this was published as `@bkincz/clutch`. Swap the package name and the imports, the API is the same.

## Quick start

```ts
import { createMachine } from '@zerosumstudio/clutch'

interface AppState {
	count: number
	todos: string[]
}

const machine = createMachine<AppState>({
	initialState: { count: 0, todos: [] },
})

// Write mutable-style code, get immutable state back
machine.mutate(draft => {
	draft.count++
	draft.todos.push('Learn Clutch')
})

machine.getState() // { count: 1, todos: ['Learn Clutch'] }

const unsubscribe = machine.subscribe(state => console.log(state))
```

The core machine has `mutate`, `set`, `batch`, `getState`, `subscribe`, `reset` and `destroy`. Everything else comes from plugins.

## Updating and reading state

`set()` shallow-merges a partial state without going through Immer, and still feeds every plugin, so undo, persist and sync keep working. `batch()` applies several recipes as one commit. `subscribe()` takes an optional selector and fires only when the selected value changes.

```ts
machine.set({ count: 2 })

machine.batch([d => void d.count++, d => void d.todos.push('Ship it')], 'Add todo')

machine.subscribe(
	state => state.count,
	(count, previous) => console.log(previous, '->', count),
)
```

Reads are free: `getState()` returns the current reference. For writes in tight loops, like drag handlers or per-frame values, prefer `set()`. Keep large collections as keyed objects rather than long arrays, and use one `mutate` recipe instead of several. A machine with no plugins skips patch generation.

`machine.reset()` returns to the initial state, clears history and rewrites persisted state. A reset is not broadcast to sync peers.

## Plugins

Install plugins with `.with()`. Calling a method from a plugin you never installed is a compile error.

```ts
import { createMachine, history, persist, devtools } from '@zerosumstudio/clutch'

const machine = createMachine<AppState>({ initialState })
	.with(history<AppState>({ maxSize: 50 }))
	.with(persist<AppState>({ key: 'app' }))
	.with(devtools<AppState>({ name: 'App' }))

machine.undo() // from history
machine.flush() // from persist
```

| Plugin       | What it adds                                       |
| ------------ | -------------------------------------------------- |
| `history()`  | Undo/redo with patch-based history                 |
| `persist()`  | localStorage persistence with debounced writes     |
| `devtools()` | Redux DevTools integration with time travel        |
| `sync()`     | State sync across tabs or via WebSocket            |
| `validate()` | Rejects commits that fail your validator or schema |
| `autosave()` | Periodic and manual saving to your server          |

Install `persist` before `sync` so hydration happens before the first sync exchange.

### history

| Option    | Description                       |
| --------- | --------------------------------- |
| `maxSize` | Snapshots to keep. Defaults to 50 |

Adds `undo()`, `redo()`, `canUndo()`, `canRedo()`, `getHistoryInfo()` and `clearHistory()`. Undo and redo return `false` when there is nothing to apply. A full-state replacement, like hydration or a reset, clears the history.

`getHistoryInfo()` returns `{ canUndo, canRedo, historyLength, currentIndex, lastAction }` and is referentially stable between history changes, so it works as a `useSyncExternalStore` snapshot.

### persist

```ts
machine.with(
	persist<AppState>({
		key: 'app',
		debounceMs: 300,
		maxChars: 5 * 1024 * 1024,
		filter: { exclude: ['draft'] },
		version: 2,
		migrate: (old, from) => upgrade(old, from),
		deferred: false,
	}),
)
```

| Option       | Description                                                                       |
| ------------ | --------------------------------------------------------------------------------- |
| `key`        | Required. The storage key                                                         |
| `storage`    | Anything with `getItem`, `setItem` and `removeItem`. Defaults to `localStorage`   |
| `debounceMs` | Delay before a write. Defaults to 300                                             |
| `maxChars`   | Larger payloads are not written. Defaults to 5 MB                                 |
| `filter`     | `{ exclude: [...] }`, `{ include: [...] }` or `{ custom: state => partialState }` |
| `version`    | Bump when the persisted shape changes. Defaults to 0                              |
| `migrate`    | `(oldState, fromVersion) => newState`, runs when the stored version differs       |
| `deferred`   | Skip hydration on install, then call `hydrate()` yourself. Defaults to `false`    |

Adds `hydrate()`, `isHydrated()`, `flush()` and `clearPersisted()`. State loads on install and writes on a debounce after every change. `flush()` forces a pending write, and writes also flush on `pagehide` and `destroy()`.

State stored under a different `version` goes through `migrate` before hydrating. Without a `migrate`, it is discarded with a warning. State stored before you added `version` counts as version 0.

For SSR, pass `deferred: true` and call `hydrate()` on the client after mount, or use the `useHydration` hook. With no browser storage available the plugin is inert, so creating machines on the server is safe.

### devtools

| Option     | Description                                                   |
| ---------- | ------------------------------------------------------------- |
| `name`     | Instance name in the extension. Defaults to `Machine`         |
| `maxAge`   | Maximum actions kept in the timeline. Defaults to 50          |
| `latency`  | Passed to the extension                                       |
| `features` | `{ jump, skip, import, export }` toggles for the extension UI |

Connects to the [Redux DevTools Extension](https://github.com/reduxjs/redux-devtools). Every commit, undo, sync update and hydration shows up in the timeline, and time travel from the extension updates the machine. It adds no methods.

### sync

```ts
machine.with(
	sync<AppState>({
		channel: 'my-app',
		mergeStrategy: 'latest',
		syncDebounce: 50,
		autoStart: true,
	}),
)
```

| Option               | Description                                                                           |
| -------------------- | ------------------------------------------------------------------------------------- |
| `channel`            | `BroadcastChannel` name for cross-tab sync. Defaults to `clutch-state-sync`           |
| `transport`          | Your own transport instead of `BroadcastChannel`, like the WebSocket one below        |
| `mergeStrategy`      | `latest` or `patches`. Defaults to `latest`                                           |
| `syncDebounce`       | Milliseconds to batch outgoing changes. Defaults to 50                                |
| `ignoreLocalChanges` | Stop broadcasting this tab's changes. Defaults to `false`                             |
| `maxClockSkewMs`     | Clock difference tolerated when ordering by timestamp. Defaults to 5 minutes          |
| `schema`             | A Standard Schema. Remote updates that fail it are dropped and reported via `onError` |
| `autoStart`          | Start on install. Defaults to `true`                                                  |

Adds `startSync()`. For server sync, pass the WebSocket transport:

```ts
import { WebSocketTransport } from '@zerosumstudio/clutch/sync-ws'

machine.with(
	sync<AppState>({
		transport: new WebSocketTransport({ url: 'wss://example.com/sync' }),
	}),
)
```

With deferred persistence, pass `autoStart: false` and call `startSync()` after `hydrate()`, so a remote response cannot race your locally persisted state. The wire format is in [docs/sync-protocol.md](./docs/sync-protocol.md).

### validate

Pass a predicate or a Standard Schema.

```ts
machine.with(validate<AppState>(state => state.count >= 0))

// Return a string to reject with your own message
machine.with(
	validate<AppState>(state => (state.count >= 0 ? true : `count went negative: ${state.count}`)),
)
```

A failing validator makes `mutate`, `set` and `batch` throw before any state is applied. Updates from outside (sync, hydration) are already applied when plugins see them, so those are reported through `onError` instead of rejected.

### autosave

```ts
machine.with(
	autosave<AppState>({
		save: state => api.put('/state', state),
		load: () => api.get('/state'),
		intervalMs: 5 * 60 * 1000,
		auto: true,
	}),
)
```

| Option       | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| `save`       | Required. Receives the state, sync or async                        |
| `load`       | Returns the server state for `loadFromServer()`                    |
| `intervalMs` | Time between saves. Defaults to 5 minutes                          |
| `auto`       | Set `false` to save only through `forceSave()`. Defaults to `true` |

Adds `forceSave()`, `hasUnsavedChanges()`, `setAutoSaveInterval(ms)` and `loadFromServer()`. Only local mutations mark the state dirty. Undo and incoming sync updates do not, since that data is already saved elsewhere. A failed save stays dirty and retries on the next interval.

## Registry

Group machines and read them as one combined state.

```ts
import { createMachine, createRegistry, history, persist } from '@zerosumstudio/clutch'

const registry = createRegistry({
	user: createMachine<UserState>({ initialState: userInit }).with(history<UserState>()),
	cart: createMachine<CartState>({ initialState: cartInit }).with(
		persist<CartState>({ key: 'cart' }),
	),
})

registry.getState() // { user: UserState, cart: CartState }
registry.subscribe(combined => render(combined))

registry.machines.user.undo() // plugin methods are preserved per machine
```

Coordination methods only reach machines that have the matching plugin installed.

| Method                                   | Reaches                  |
| ---------------------------------------- | ------------------------ |
| `resetAll()`                             | Every machine            |
| `hydrateAll()` / `flushAll()`            | Machines with `persist`  |
| `forceSaveAll()` / `hasUnsavedChanges()` | Machines with `autosave` |
| `clearAllHistory()`                      | Machines with `history`  |
| `destroyAll()`                           | Every machine            |

The machine map is fixed at creation.

## Micro frontends

`sharedMachine` creates a machine once per page and returns the same instance to every caller of the same key, whichever bundle the call comes from.

```ts
import { createMachine, persist, sharedMachine } from '@zerosumstudio/clutch'

export const playerMachine = sharedMachine('app:player', () =>
	createMachine<PlayerState>({ initialState }).with(persist<PlayerState>({ key: 'player' })),
)
```

Each app keeps its own copy of this module and they all end up on one machine. The registry lives on `globalThis` and instances are used structurally, so it works even when apps bundle separate copies of clutch. With Module Federation, share clutch as a singleton so only one copy loads:

```jsonc
// the shared option of your federation plugin, or "shared" in spool.json
"shared": ["react", "react-dom", "@zerosumstudio/clutch", "@zerosumstudio/clutch/react"]
```

Independent deployments can disagree on the state shape. Declare a `contract` and clutch warns at runtime when two apps differ, naming the key and both versions. Mismatched clutch versions across bundles get the same warning.

For a shape change that should migrate rather than warn, declare a numeric `version` and a `migrate`. When an app with a higher `version` joins, `migrate(previousState, fromVersion)` upgrades the shared state in place. `version` takes precedence over `contract` when both sides declare one.

```ts
sharedMachine('app:player', factory, {
	version: 2,
	migrate: (previous, from) => upgrade(previous, from),
})
```

A lower `version` than the shared state, a missing `migrate` and a `migrate` that throws each warn and leave the state alone.

Micro frontends in separate iframes or tabs have no shared page to share an instance on. Use the `sync` plugin, whose `BroadcastChannel` transport keeps same-origin machines in step.

Live demo: [Resonate](https://spool-demo-shell.pages.dev), a music UI where the browse view, search and player bar are separately deployed apps sharing one player machine, built with [spool](https://github.com/zerosumstudio/spool).

## React

Hooks live in `@zerosumstudio/clutch/react`. The main entry stays React-free.

```tsx
import { useMachine, useSlice } from '@zerosumstudio/clutch/react'

function Counter() {
	const { state, mutate } = useMachine(machine)

	return (
		<button
			onClick={() =>
				mutate(d => {
					d.count++
				})
			}
		>
			{state.count}
		</button>
	)
}

function CountLabel() {
	// re-renders only when the selected value changes
	const count = useSlice(machine, s => s.count)

	return <span>{count}</span>
}
```

| Hook                                                | Needs             | Returns                                                                                                                                 |
| --------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `useMachine(machine)`                               | core              | `{ state, mutate, batch }`                                                                                                              |
| `useSlice(machine, selector, equalityFn?)`          | core              | The selected value                                                                                                                      |
| `useSubscription(machine, callback)`                | core              | Nothing, runs your callback on changes                                                                                                  |
| `useRegistry(registry)`                             | registry          | Combined state                                                                                                                          |
| `useRegistrySlice(registry, selector, equalityFn?)` | registry          | The selected value                                                                                                                      |
| `useMachineHistory(machine)`                        | `history` plugin  | History info plus `undo`, `redo`, `clearHistory`                                                                                        |
| `useHydration(machine)`                             | `persist` plugin  | `{ isHydrated }`, hydrates on mount                                                                                                     |
| `useAutosave(machine)`                              | `autosave` plugin | `save`, `load`, `isSaving`, `isLoading`, `lastSaved`, `saveError`, `loadError`, `hasUnsavedChanges` and the two `clear*Error` functions |
| `createMachineScope(factory, name?)`                | core              | `{ Provider, useScopedMachine }`, one machine per provider                                                                              |

The plugin hooks require the plugin's methods on the machine type, so passing a machine without that plugin fails to compile.

### Request-scoped machines

A module-level machine is one object per process. On a server, every concurrent request renders against the same instance, so one user's data can reach another user's render. `deferred` does not help, because this isn't a persistence problem. Build the machine per render tree with `createMachineScope(factory, name?)`, which returns a `Provider` that builds one machine per mount and a hook that reads it.

```tsx
import { createMachine } from '@zerosumstudio/clutch'
import { createMachineScope, useSlice } from '@zerosumstudio/clutch/react'

const { Provider: UserProvider, useScopedMachine: useUserMachine } = createMachineScope(
	() => createMachine<UserState>({ initialState: { details: null } }),
	'User',
)

// server component, userDetails differ per request
export default async function Layout({ children }) {
	const userDetails = await getUserDetails()

	return <UserProvider state={{ details: userDetails }}>{children}</UserProvider>
}

// any client component below it
function Greeting() {
	const machine = useUserMachine()
	const name = useSlice(machine, s => s.details?.name ?? '')

	return <span>{name}</span>
}
```

`state` is merged in before the first render, so children never see an empty store, and again whenever it changes by value. A parent re-render that rebuilds an equal object does not re-seed, so writes made in between survive. `name` sets the context display name and appears in the error thrown when the hook runs outside its provider.

Use a scope only for data that belongs to a single request. Client-only state like UI preferences is fine on a module-level machine.

## Writing a plugin

A plugin is an object with a name and lifecycle hooks. Whatever `onInit` returns is merged onto the machine and shows up in its type.

```ts
import type { Plugin } from '@zerosumstudio/clutch'

function logger<T extends object>(): Plugin<T, { getLogCount(): number }> {
	let count = 0

	return {
		name: 'logger',
		onInit: () => ({ getLogCount: () => count }),
		onCommit: payload => {
			count++
			console.log(payload.description ?? payload.operation, payload.patches)
		},
	}
}

const machine = createMachine({ initialState }).with(logger())
machine.getLogCount()
```

| Hook                           | When it runs                                                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onInit(ctx)`                  | At install. Return an object to extend the machine. `ctx` gives you `getState`, `subscribe`, `replaceState`, `applyPatches`, `notify` and `emitError`                                                 |
| `onBeforeCommit(payload)`      | Before a mutation is applied. Throw to reject it                                                                                                                                                      |
| `onCommit(payload)`            | After a mutation is applied, before subscribers are notified. The payload has the new state, patches, inverse patches, description, operation and timestamp                                           |
| `onExternalState(state, meta)` | When state changes outside the mutation path: sync updates, hydration, undo, time travel, reset. `meta.source` names the plugin that caused it. Your own `ctx.replaceState` calls are not echoed back |
| `onError(error, operation)`    | When any plugin reports an error                                                                                                                                                                      |
| `onDestroy(finalState)`        | On `machine.destroy()`, in reverse install order                                                                                                                                                      |

Plugin names must be unique per machine, and extension keys must not collide with existing methods. Both throw at install time.

## Size

Minified and brotli compressed, including dependencies. Plugins you do not import are tree-shaken away.

| Import                           | Size     |
| -------------------------------- | -------- |
| `{ createMachine }` only         | ~5.8 KB  |
| Everything                       | ~10.7 KB |
| React hooks (`/react`)           | ~2.0 KB  |
| WebSocket transport (`/sync-ws`) | ~1.1 KB  |

## TypeScript

State types are inferred from `initialState`, or pass them explicitly with `createMachine<AppState>(...)`. Each `.with()` widens the machine type with the plugin's API.

```ts
const machine = createMachine<AppState>({ initialState }).with(history<AppState>())

machine.undo() // ok
machine.hydrate() // compile error, persist is not installed
```

To name the type of a plugin-extended machine, build it in a function and use `ReturnType<typeof build>`.

## License

MIT © zerosum studio
