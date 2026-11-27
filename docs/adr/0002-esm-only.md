# 2. ESM only, on Node 26

Status: accepted

## Context

The package shipped ESM and CJS. Two copies of the package in one app break `instanceof StoreError` and the version check in `sharedStore`. Node 22.12 and later can load ESM from `require()`, but development and CI run on Node 26 and that is the only version we test.

## Decision

- Build with tsdown to ESM only, unminified, with no property mangling. Consumers minify, and stack traces stay readable.
- `exports` lists `.`, `./react`, `./immer`, `./sync-ws` and `./package.json`, each with `types` and `default`.
- `engines.node` is `>=26` and `.nvmrc` is 26. This applies to consumers as well: it states the one version the package is tested on, rather than a floor we have not checked. A smoke test runs against `dist` and `require()`s the ESM entry.

## Consequences

- No dual-package hazard.
- Jest setups that transform to CJS need `transformIgnorePatterns` for the package.
- Installs on an older Node warn, or fail where the package manager enforces `engines` (Yarn classic, or pnpm with `engine-strict`).
- Property mangling is gone. It had renamed `__REDUX_DEVTOOLS_EXTENSION__` in the published build.
