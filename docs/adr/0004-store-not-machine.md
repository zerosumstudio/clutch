# 4. Store, not machine

Status: accepted

## Context

Clutch has no states or transitions, so "machine" promised something it does not do.

## Decision

The public API says store: `createStore`, `Store`, `StoreError`, `StoreErrorCode`, `StoreConfig`, `useStore`, `sharedStore`, `createStoreScope` and `useScopedStore`. Registries hold `stores`, with `StoreMap` for the type. The shared registry lives on `globalThis.__clutchSharedStores`.

## Consequences

- Every name changes from 3.5.0. The migration guide carries the mapping.
