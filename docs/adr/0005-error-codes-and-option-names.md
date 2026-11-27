# 5. Error codes and option names

Status: accepted

## Context

Error codes mixed `_ERROR` and `_REJECTED` suffixes, and `VALIDATION_ERROR` covered misuse, a veto, malformed patches and conflicts. "Start on install" was `autoStart` on sync, an inverted `deferred` on persist and `auto` on autosave.

## Decision

- `StoreErrorCode` has no `_ERROR` suffix and one meaning per code: `INVALID_ARGUMENT`, `VALIDATION_FAILED`, `PATCH_CONFLICT`, `DESTROYED`, `DUPLICATE_PLUGIN`, `EXTENSION_COLLISION`, `PERSISTENCE_FAILED`, `AUTOSAVE_FAILED` (save and load), `SYNC_REJECTED`, `SYNC_FAILED`, `DEVTOOLS_FAILED` and `PLUGIN_FAILED`.
- A patch that does not fit the current state is `PATCH_CONFLICT`, which sync answers with a resync and does not report. A malformed one is `INVALID_ARGUMENT`.
- `autoStart` (default `true`) is the one name on `sync`, `persist` and `autosave`. Persist hydrates on install, and autosave runs its interval, only while it is true.
- Plugin state is named by what it is: `getAutosaveState()` returns an `AutosaveState`, and history info has `length` and `lastDescription`.

## Consequences

- The migration guide maps `deferred: true` to `autoStart: false` and `auto: false` to `autoStart: false`.
