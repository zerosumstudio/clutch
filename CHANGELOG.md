# Changelog

## 1.0.0 - 2026-11-28

First release under `@zerosumstudio`. Everything below is a change from `@bkincz/clutch` 3.5.0, and the [migration guide](./docs/migration-1.0.md) opens with a search-and-replace checklist.

### Breaking

- **Published as `@zerosumstudio/clutch`.** Swap the package name and the imports. `@bkincz/clutch` stays on npm at 3.5.0.
- **Machine is now Store.** `createMachine`, `MachineError`, `sharedMachine`, `createMachineScope` and `registry.machines` become `createStore`, `StoreError`, `sharedStore`, `createStoreScope` and `registry.stores`.
- **Immer is an optional plugin.** `pnpm add immer`, then `.with(immer())` from `@zerosumstudio/clutch/immer` to get `mutate`. `Draft` is exported from there too.
- **`batch` is removed.** Use one `mutate` recipe, or one `set`.
- **React hooks are consolidated.** `useMachine` and `useSlice` become `useStore(store, selector?, isEqual?)`, which returns state and not `{ state, mutate, batch }`. `useRegistrySlice` becomes `useRegistry(registry, selector?)` and `useMachineHistory` becomes `useHistory`. React 18 or newer.
- **`useAutosave` and `autosave` report one status.** Read `status`, `error` and `lastSavedAt` instead of `isSaving`, `isLoading`, `saveError`, `loadError` and `lastSaved`. `forceSave()` is `save()`, `loadFromServer()` is `load()`, `auto` is `autoStart`, and `setAutoSaveInterval()` is gone.
- **`sync({ channel })` is required.** The shared default channel is gone. `mergeStrategy` is `mode` (`state` or `patches`) and `syncDebounce` is `debounceMs`. Messages carry `channel` and no longer carry `inversePatches`, so custom WebSocket servers relay `channel` unchanged. A 3.5 tab and a 1.0 tab don't sync.
- **WebSocket `authMode` defaults to `message`.** The server must accept a first `{ type: 'auth', token }` frame, or set `authMode: 'query'`. The transport's `onError` option is gone, so its errors reach the store's `onError` as `SYNC_FAILED`.
- **`persist({ filter })` is `pick`, and `deferred` is `autoStart`.** `deferred: true` becomes `autoStart: false`. `hydrate()`, `flush()` and `clearPersisted()` return promises, and `migrate` receives `unknown`. Stored data needs no migration.
- **Registry helpers are removed.** `hydrateAll`, `flushAll`, `forceSaveAll`, `hasUnsavedChanges` and `clearAllHistory`. Loop over `registry.stores`.
- **Classes are types only.** `Machine` and `Registry` are exported as types, and `BroadcastChannelTransport` is no longer exported. Use `createStore` and `createRegistry`.
- **Error codes are renamed and split.** `VALIDATION_ERROR` becomes `INVALID_ARGUMENT`, `VALIDATION_FAILED` or `PATCH_CONFLICT`, and `PERSISTENCE_ERROR` becomes `PERSISTENCE_FAILED` or `AUTOSAVE_FAILED`. `StoreError.code` is a `StoreErrorCode`.
- **History info is renamed.** `historyLength` is `length` and `lastAction` is `lastDescription`.
- **Types are renamed or removed.** `SyncPluginConfig` is `SyncConfig`, `DevToolsConfig` is `DevtoolsConfig`, and `CommitPayload.operation`, `EmptyExtension`, `HistorySnapshot`, `PersistedEnvelope`, `PersistFilter` and `CommitOperation` are gone. `Patch` is clutch's own type.
- **ESM only, Node 26 or newer.** `require()` of the package still works on Node 26.
- **Autosave counts undo, hydration and `reset()` as unsaved changes.** It starts its interval without a `window`, and `load()` rejects with `AUTOSAVE_FAILED` on failure.

### Added

- **Core works without immer.** `set` takes a function of the current state, and history, sync and DevTools run on top-level patches.
- **`persist({ schema })`.** Stored state that fails the schema is reported and not applied, and writes stop so the stored copy survives.
- **`sync({ pick })`.** Limits what is sent to peers and which keys are accepted from them.
- **Async storage for `persist`.** `getItem`, `setItem` and `removeItem` can return promises.
- **`shallowEqual`** for selectors that return a fresh object.
- **`getAutosaveState()`** on `autosave`.
- **Plugin API types are exported**, so a plugin-extended store can be named: `Store<AppState> & HistoryApi`.
- **`maxMessageChars`** on `WebSocketTransport` drops oversized inbound frames.
- Sync, transport and DevTools failures reach `onError` instead of the console.

### Changed

- The core is 1.89 KB brotli, down from 5.8 KB. Immer and `use-sync-external-store` are no longer dependencies, and the output is unminified.
- `createStoreScope` destroys its store when the provider unmounts.
- A remote update keeps the history stack unless it touches a key the stack recorded.
- DevTools instances are named `Store` by default, and log lines use the `[clutch]` prefix.

### Fixed

- DevTools connects in the published build. Property mangling had renamed `__REDUX_DEVTOOLS_EXTENSION__`.
- Concurrent edits from different tabs settle on one winner on every tab, instead of diverging for good.
- Autosave no longer marks a change made during a save as saved, and saves no longer overlap.
- `useHydration().isHydrated` turns `true` when nothing is stored.
- A local change before `hydrate()` no longer overwrites stored data, and a `migrate` that throws no longer overwrites it either.
- `clearPersisted()` cancels a pending write instead of bringing the data back.
- `useHistory` updates after `clearHistory()`.
- `useAutosave` can report a load failure.
- WebSocket reconnect backs off when the server accepts the connection and then closes it.
- `sync` with a `schema` asks for a resync when it drops a patch.
- Patches with a `__proto__` path or value are rejected, and keys named `constructor` or `prototype` are ordinary data.
- A plugin that throws in `onInit` leaves nothing running.
- A Node process exits with a default `sync()` installed.
- `replaceState` rejects a non-object state.

## 3.5.0 - 2026-08-13

### Breaking

- **Node 22.12 is the minimum** (`engines`).

### Added

- **`createMachineScope(factory, name?)`** in `@bkincz/clutch/react` returns a
  `Provider` that creates one machine per mount and a `useScopedMachine` hook, so each
  server render tree gets its own instance.
- The provider takes an optional `state` prop, merged in before the first render
  and re-applied when it changes by value.
- **`ctx.notify()` on `PluginContext`** publishes a change a plugin exposes through
  its own API without touching state.
- **`StandardSchemaV1` is exported from the main entry**, so wrappers around
  `validate` and `sync` can be typed.

### Changed

- New runtime dependency: `use-sync-external-store`, around 1 KB.
- `immer` is `^11.1.16`, up from `>=9.0.0`, so a consumer can no longer resolve
  immer 9.
- `useSlice` and `useRegistrySlice` run through `useSyncExternalStoreWithSelector`
  and no longer keep a mirror of state in a ref. An inline selector that changes
  identity every render is re-run on read.
- `useHydration` and `useAutosave` read through `useSyncExternalStore` instead of
  copying plugin flags into local state.

### Fixed

- `forceSave()` notifies subscribers, so `useAutosave().hasUnsavedChanges` clears
  after a manual save.
- `loadFromServer()` clears the dirty flag before replacing state.

## 3.3.1 - 2026-07-10

- **Standard Schema moved out of `validate`** into its own module, so more than one
  plugin can accept a schema.
- **`sync({ schema })`.** A remote update that fails the schema is dropped and
  reported through the machine's error channel.

## 3.3.0 - 2026-07-10

- **`validate` accepts a Standard Schema** (zod, valibot, arktype) in place of a
  predicate. Issues come back as the rejection message.
- **`sharedMachine({ version, migrate })`.** The higher version migrates the shared
  state in place. A downgrade, a missing `migrate` or a throwing `migrate` warns and
  leaves the state alone. `version` takes precedence over `contract`.
- **`machine.replaceState(state, meta?)`** is public.

## 3.2.0 - 2026-07-06

### Breaking

- **The v2 API and the `createV2Machine` bridge are gone.** Finish the v2 to v3
  migration before upgrading.

### Added

- **`machine.set(partial)`**, a shallow merge without immer, roughly 7x faster than
  `mutate`. History, persist, sync and devtools treat it like any other commit.
- **`persist` versioning** with `version` and `migrate(oldState, fromVersion)`.
  State from a different version migrates on hydrate, or is discarded with a warning
  when there is no migration. Unversioned state counts as version 0.
- **`machine.subscribe(selector, listener, equalityFn?)`** fires with
  `(selected, previous)` only when the selection changes.
- **`batch`** accepts a single recipe as well as an array.
- **`validate`** can return a string to reject with that message.

### Changed

- Machines without plugins skip immer patch generation, roughly doubling `mutate`
  throughput.
- `enablePatches()` runs when the first machine is created, not at import.
- `initialState` is deep-frozen, so external mutation can't corrupt what `reset()`
  restores.

## 3.1.0 - 2026-07-06

- **`sharedMachine(key, factory, options?)`** creates a machine once per page and
  returns the same instance to every caller of the same key, across bundles. Pass
  `{ contract: n }` to warn on a state shape mismatch. See the README's "Micro
  frontends".

## 3.0.0 - 2026-06-12

Core does immutable updates and subscriptions only, and every feature is a plugin
installed with `.with()`.

### Breaking

- **`createStateMachine` / `StateMachine` are replaced by `createMachine` +
  plugins.** Undo/redo, persistence, DevTools, sync, validation and autosave are
  `history()`, `persist()`, `devtools()`, `sync()`, `validate()` and `autosave()`.
- **`createV2Machine(config)`** bridges a v2 `StateConfig` to the matching plugins,
  to migrate one import at a time.
- **Subclassing for server persistence is gone.** `saveToServer` / `loadFromServer`
  overrides become `autosave({ save, load })`.
- **`StateRegistry` is replaced by `createRegistry(machines)`.** Machines are typed
  per entry, and `forceSaveAll`, `clearAllHistory`, `hydrateAll` and `flushAll` only
  reach machines with the matching plugin.
- **React hooks are renamed.** `useStateMachine` is `useMachine`, `useStateSlice` is
  `useSlice`, `useStateHistory` is `useMachineHistory`, `useStatePersist` is
  `useAutosave`, `useDeferredHydration` is `useHydration`.
- **`StateMachineError` is `MachineError`**, with the same `code` field.
- **`enableLogging` is removed.**

### Added

- **`Plugin<T, Ext>`** with `onInit`, `onBeforeCommit` (throw to veto), `onCommit`,
  `onExternalState`, `onError` and `onDestroy`. What `onInit` returns is merged onto
  the machine and its type.
- **`persist({ storage })`** accepts any `getItem` / `setItem` / `removeItem` object.
- **`sync({ autoStart: false })` and `startSync()`** for SSR flows.
- **`autosave({ auto: false })`** for manual-save-only setups.

### Fixed

- Listeners fire after plugins update their bookkeeping, so a React snapshot read
  during notification no longer sees stale undo or dirty flags.

## 2.0.0 - 2026-06-10

### Breaking

- **React hooks moved to `@bkincz/clutch/react`.** The main entry is React-free.
- **`autoSaveInterval` (minutes) is `autoSaveIntervalMs`.** `setAutoSaveInterval()`
  takes milliseconds too.
- **`subscribe()` no longer calls the listener immediately.** It fires on the next
  state change.
- **Persisted-state `checksum` and `version` fields are removed.** Old persisted
  state still loads.
- **`StateHistoryInfo.memoryUsage` is removed.**
- **Middleware is synchronous** (`=> void`). Async middleware never worked.
- **Notifications are synchronous.** The 16ms debounce caused cursor jumps in
  controlled inputs.

### Added

- **`createStateMachine(config)`**. `StateMachine` is no longer abstract, so
  `new StateMachine(config)` works. Subclass only to override `saveToServer` /
  `loadFromServer`.
- **`applyPatchSet(patches, description?)`** applies Immer patches as a regular
  mutation.

### Changed

- localStorage writes are debounced (300ms, trailing), with flushes on `pagehide`
  and `destroy()`.
- `immer` moved from `peerDependencies` to a regular dependency.

### Fixed

- Undo and redo broadcast to sync and DevTools, so tabs no longer diverge after an
  undo.
- `useStateHistory` caches its snapshot until history changes, fixing React's
  "getSnapshot should be cached" loop.
- `useStateSlice` and `useRegistrySlice` no longer serve stale values when the
  selector changes.
- `useOptimisticUpdate` rollback reverts only the optimistic change.
- Persistence writes are synchronous again, so they can't land out of order.

## 1.4.0 - 2026-06-06

### Added

- **Pluggable sync transports.** `SyncConfig` accepts `transport: SyncTransport`,
  and `BroadcastChannelTransport` stays the default. The transport types are exported
  from the main entry.
- **WebSocket server sync** through the opt-in `@bkincz/clutch/sync-ws` entry.
  `WebSocketTransport` reconnects, queues offline writes, and authenticates by query
  param or first frame. The wire protocol is in `docs/sync-protocol.md`.

### Fixed

- With `deferredHydration: true`, sync starts at `hydrateFromPersisted()`, so a
  remote full-sync can't overwrite persisted state before hydration reads it.
- `StateSyncManager` calls Immer's `enablePatches()` itself, so it works standalone.
- Inbound `full_sync` requests skip the timestamp-window check, so a clock-skewed
  client can still request a resync.
