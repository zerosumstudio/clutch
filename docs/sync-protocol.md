# Clutch Server Sync Protocol

Wire protocol for syncing Clutch state through a server using `WebSocketTransport`
(`@zerosumstudio/clutch/sync-ws`). The server is a **stamping relay**: it orders messages and
broadcasts them. It does not need to understand patches or hold application state.

All frames are JSON text messages.

## Client → Server

### State messages

Sent whenever local state changes (debounced by `debounceMs`). Every message carries the `channel`
the store was configured with, and the client drops any message whose `channel` differs from its
own. The server relays it unchanged.

```jsonc
// mode: 'state'
{
	"type": "state_update",
	"channel": "cart",                              // required: the `channel` option of sync()
	"instanceId": "instance_1781070740908_vs6znzn", // unique per client instance
	"timestamp": 1781070740908,                     // client logical clock, see Ordering
	"state": { /* full state, or only the keys `pick` returns */ },
	"description": "increment count"                // optional
}

// mode: 'patches'
{
	"type": "patches",
	"channel": "cart",
	"instanceId": "instance_...",
	"timestamp": 1781070740908,
	"patches": [{ "op": "replace", "path": ["count"], "value": 5 }]
}
```

Patches use the `add`, `replace` and `remove` ops, with `path` as an array of strings and finite
numbers. A store in `state` mode refuses `patches` messages. A patch on an array `length` can only
shrink the array. Paths only address own keys of plain objects and arrays, so a key called
`constructor` or `prototype` is ordinary data. A path segment of `__proto__`, and any value that
contains an own `__proto__` key, is rejected.

With `pick`, `state_update` messages hold only the picked keys, and `patches` messages only carry
patches whose first path segment is a picked key. The receiver applies only keys its own `pick`
returns. A change to the whole root is sent as the picked state, since a root patch can't be
filtered.

### Resync request

Sent on connect, on reconnect, and when a client detects a version gap or cannot apply a patch:

```jsonc
{ "type": "full_sync", "channel": "cart", "instanceId": "instance_...", "timestamp": 1781070740908 }
```

### Heartbeat

```jsonc
{ "type": "ping" }
```

### Auth

With `authMode: 'message'` (the default), the first frame after the socket opens is:

```jsonc
{ "type": "auth", "token": "..." }
```

With `authMode: 'query'`, the token is appended to the URL instead:
`wss://example.com/sync?token=...`. URLs end up in logs and proxies, so prefer `message`.

The server must treat **every socket as unauthenticated until a valid `auth` frame arrives**. It
relays nothing to or from an unauthenticated socket, and closes it if the first frame is anything
else, or if no `auth` frame arrives before a short deadline. With `authMode: 'query'`, authenticate
during the upgrade instead.

When `getAuthToken` returns a different token on a reconnect, the transport drops its offline queue
first, so frames written under one session are not sent as another.

## Server → Client

### Version stamping (required)

For every inbound `state_update` or `patches` message, the server MUST:

1. Increment a **single monotonic counter** per channel/room (start at 1).
2. Attach it as `version` to the message.
3. **Broadcast the stamped message to ALL clients in the channel, including the sender.** The echo
   is how the sender advances its own version cursor. Without it, every change the sender makes
   causes the next inbound message to look like a version gap, triggering needless resync churn.
   There is no separate ack type.

```jsonc
{
	"type": "patches",
	"channel": "cart", // Unchanged
	"instanceId": "instance_...", // Unchanged. Clients use it to ignore their own echo
	"timestamp": 1781070740908,
	"patches": [/* unchanged */],
	"version": 42, // Server-assigned, monotonic
}
```

The server must also **overwrite `version` on every message** (a client-supplied one could freeze
other clients' cursors), and **bind `instanceId` to the socket**: reject any frame whose
`instanceId` is not the one that socket first used, since a client treats a message carrying its own
`instanceId` as an echo and skips it.

Clients order strictly by `version` and ignore `timestamp` on versioned messages (client clocks
cannot be trusted across devices). Versioned messages with `version <= lastSeen` are dropped as
duplicates. A `patches` message that skips a version is dropped and answered with a `full_sync`
request; a `state_update` is self-contained, so gaps are tolerated. A `patches` message the client
cannot apply (for example one that fails the store's `schema`) is not counted as seen, and also
answered with a `full_sync` request.

### Resync relay

On `full_sync`, relay the request verbatim to all **other** clients in the channel. One of them
responds with a full `state_update`, which gets stamped and broadcast as usual. (Optional
optimization: a server that caches the last full state may answer `full_sync` directly with a
stamped `state_update`.)

### Heartbeat reply

Answer `ping` with:

```jsonc
{ "type": "pong" }
```

`pong` frames are consumed by the transport and never reach application code.

## Ordering without a stamping server

Over `BroadcastChannel`, or a relay that does not stamp, there is no `version`. Clients order
messages by a logical clock instead, so every peer picks the same winner when edits cross:

- Each message is stamped `timestamp = max(Date.now(), clock + 1)`, and a client moves its clock
  forward to the `timestamp` of every message it reads. A peer with a fast clock therefore cannot
  make later messages from the others look stale.
- Messages are compared as `(timestamp, instanceId)`. Two messages stamped in the same millisecond
  are ordered by instance id, and the higher one wins on every client, whichever arrives first.
- A message is dropped when it is not newer than one already applied, or when the client has its own
  newer change, either pending in the debounce window or already sent. The sender receives that
  newer change next.
- In `patches` mode, a dropped patch message makes the receiver send its whole state in place of its
  next patches, so the sender converges on it.

Concurrent edits resolve to one side's state, the same everywhere. They are not merged, so an edit
that loses is lost. Use a stamping server when edits must be merged in order.

A change that keeps arriving without a pause is still sent at least every ten debounce windows.

Messages with a `timestamp` more than `maxClockSkewMs` from the local clock are rejected and
reported through `onError` as `SYNC_REJECTED`.

## Minimal server pseudocode

```js
// per channel
let version = 0
const clients = new Set() // authenticated sockets only

function onConnect(socket) {
	socket.authenticated = false
	socket.deadline = setTimeout(() => socket.close(), 5000)
}

function onMessage(sender, msg) {
	// Nothing is read from, or relayed to, a socket that has not authenticated
	if (!sender.authenticated) {
		if (msg.type !== 'auth' || !validate(msg.token)) {
			return sender.close()
		}

		clearTimeout(sender.deadline)
		sender.authenticated = true
		clients.add(sender)

		return
	}

	switch (msg.type) {
		case 'state_update':
		case 'patches':
			if (!sender.instanceId) sender.instanceId = msg.instanceId
			if (msg.instanceId !== sender.instanceId) return sender.close()

			msg.version = ++version // always the server's own, whatever the client sent
			for (const c of clients) c.send(JSON.stringify(msg)) // including sender!
			break
		case 'full_sync':
			for (const c of clients) if (c !== sender) c.send(JSON.stringify(msg))
			break
		case 'ping':
			sender.send(JSON.stringify({ type: 'pong' }))
			break
	}
}
```

## Security expectations

Clutch validates inbound payload structure and rejects prototype-pollution attempts, but the server
owns real authorization:

- Authenticate connections (`auth` frame, or token query param with `authMode: 'query'`), and keep
  unauthenticated sockets out of the channel entirely, as in the pseudocode above.
- Authorize per channel/room - patches can address **any path** in the state, so a client allowed
  into a channel can write all of its synced state. Use `pick` to keep secrets such as tokens out of
  what is sent and accepted.
- Enforce message size limits and rate limits server-side. The client also drops inbound frames
  larger than `maxMessageChars` (5 MB by default) before parsing them.

## Serialization caveat

WebSocket frames are JSON. State containing `Date`, `Map`, `Set`, `undefined`, or class instances
survives BroadcastChannel's structured clone but **not** JSON. Keep server-synced state
JSON-serializable.
