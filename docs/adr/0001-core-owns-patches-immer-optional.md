# 1. Core owns patches, immer is optional

Status: accepted

## Context

Immer was a hard dependency and about 4.4 KB of the 5.8 KB core bundle. History, sync and devtools only need patches, and a plain `set` update does not need immer to produce them.

## Decision

- Core owns the `Patch` type, a top-level key diff, a safe `applyPatches` and `deepFreeze`. Every commit carries patches: top-level ones from `set`, deep ones from the immer plugin.
- `@zerosumstudio/clutch/immer` adds `mutate` and re-exports `Draft`. Immer is an optional peer dependency (`^11.1.16`), and `enablePatches()` runs inside the `immer()` factory, never at import time.
- Plugins commit through `ctx.commit(state, { patches?, inversePatches?, description? })`.
- `applyPatches` accepts string and finite-number path segments, rejects `__proto__`, and only addresses own keys. `constructor` and `prototype` are ordinary data keys, so they are safe to accept and a record keyed by user input does not break.
- An array `length` patch can only shrink, so a small patch cannot allocate a huge sparse array.
- Immer is the test oracle for the applier. Map and Set are not supported, as before.

## Consequences

- Core is about 1.8 KB. Immer users pay for immer once, in their own bundle.
- History and sync `patches` mode work without immer, at top-level key granularity.
- `batch` is gone: one `mutate` recipe already commits once.
