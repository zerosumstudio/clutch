# 3. Sync requires a channel

Status: accepted

## Context

Sync defaulted to one shared channel name. Every store on that origin then copied every other store, tokens included, with no warning.

## Decision

- `sync({ channel })` is required. Each message is stamped with its `channel` and a receiver ignores any message with a different one, on every transport.
- Inbound messages are shape-checked, and rejected ones are reported through `onError` as `SYNC_REJECTED`.
- `pick` limits what is sent and which keys are accepted from peers.

## Consequences

- Stores that should share state pick the same channel name on purpose.
- Custom WebSocket servers relay the `channel` field unchanged.
