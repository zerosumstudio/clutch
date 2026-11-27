/*
 *   IMPORTS
 ***************************************************************************************************/
import { StoreError, toStoreError } from './error'
import { applyPatches, diffState, hasProtoKey, isStateObject, type Patch } from './patch'
import { BroadcastChannelTransport } from './transports/broadcast-channel'
import type { SyncTransport, TransportStatus } from './transports/types'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SyncManagerConfig<T> {
	channel: string
	mode: 'state' | 'patches'
	debounceMs: number
	ignoreLocalChanges: boolean
	maxClockSkewMs: number
	pick: ((state: T) => Partial<T>) | undefined
	transport: SyncTransport | undefined
}

export interface SyncHost<T> {
	getState(): T
	/** Applies a remote update. Returns false when the host rejected it. */
	applyRemote(state: T, patches: Patch[]): boolean
	onError(error: StoreError): void
}

interface SyncMessage<T> {
	type: 'state_update' | 'full_sync' | 'patches'
	channel: string
	instanceId: string
	timestamp: number
	state?: Partial<T>
	patches?: Patch[]
	description?: string | undefined
	// Server-assigned monotonic version. When present, ordering is version-based
	// and timestamp checks are skipped.
	version?: number
}

interface Stamp {
	timestamp: number
	instanceId: string
}

// A change waits at most this many debounce windows before it is sent, so an edit that never
// pauses (a slider, a drag) still reaches peers
const MAX_WAIT_DEBOUNCES = 10

/*
 *   HELPERS
 ***************************************************************************************************/
function isNewer(stamp: Stamp, than: Stamp | null): boolean {
	if (!than) {
		return true
	}

	if (stamp.timestamp !== than.timestamp) {
		return stamp.timestamp > than.timestamp
	}

	return stamp.instanceId > than.instanceId
}

/*
 *   STATE SYNC MANAGER
 ***************************************************************************************************/
// Unversioned messages (BroadcastChannel, or a relay that doesn't stamp) are ordered by a logical
// clock plus instance id, so every peer picks the same winner when edits cross. Versioned messages
// are ordered by the server's version instead.
export class StateSyncManager<T extends object> {
	private transport: SyncTransport
	private instanceId: string
	private clock = 0
	private lastSent: Stamp | null = null
	private lastApplied: Stamp | null = null
	private lastVersion: number | null = null
	private resyncPending = false
	private syncTimer: ReturnType<typeof setTimeout> | null = null
	private pendingSince: number | null = null
	private hasPendingState = false
	private needsFullState = false
	private pendingPatches: Patch[] = []
	private pendingDescription: string | undefined

	constructor(
		private config: SyncManagerConfig<T>,
		private host: SyncHost<T>,
	) {
		this.instanceId = `instance_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
		this.transport =
			config.transport ?? new BroadcastChannelTransport({ channel: config.channel })
		this.initialize()
	}

	private initialize(): void {
		this.transport.onMessage(message => this.handleMessage(message))

		this.transport.onStatusChange?.(status => this.handleStatusChange(status))

		this.transport.onError?.(error =>
			this.host.onError(toStoreError(error, 'SYNC_FAILED', 'Sync transport error')),
		)

		this.transport.start?.()

		// Without status events the transport is live now. Otherwise the 'connected' status asks
		if (!this.transport.onStatusChange) {
			this.requestFullSync()
		}
	}

	private handleStatusChange(status: TransportStatus): void {
		if (status === 'connected') {
			// A reconnect invalidates the version cursor, so always resync from scratch
			this.lastVersion = null
			this.resyncPending = false
			this.requestFullSync()
		}
	}

	/*
	 * OUTBOUND
	 */
	public broadcastChange(patches: Patch[], description?: string): void {
		if (this.config.ignoreLocalChanges) {
			return
		}

		if (this.config.mode === 'patches') {
			this.pendingPatches.push(...patches)
		} else {
			this.hasPendingState = true
		}

		this.pendingDescription = description ?? this.pendingDescription

		this.scheduleFlush()
	}

	private hasPending(): boolean {
		return this.hasPendingState || this.needsFullState || this.pendingPatches.length > 0
	}

	private scheduleFlush(): void {
		const now = Date.now()
		this.pendingSince ??= now

		if (this.syncTimer) {
			clearTimeout(this.syncTimer)
		}

		const deadline = this.pendingSince + this.config.debounceMs * MAX_WAIT_DEBOUNCES
		const delay = Math.max(0, Math.min(this.config.debounceMs, deadline - now))

		this.syncTimer = setTimeout(() => {
			this.syncTimer = null
			this.flushPending()
		}, delay)
	}

	private flushPending(): void {
		this.pendingSince = null

		if (!this.hasPending()) {
			return
		}

		// A patch on the root can't be filtered by key, so `pick` sends the whole picked state
		const hasRootPatch = this.config.pick && this.pendingPatches.some(p => p.path.length === 0)
		const sendPatches =
			this.config.mode === 'patches' &&
			!this.needsFullState &&
			!hasRootPatch &&
			this.pendingPatches.length > 0
		const description = this.pendingDescription
		const patches = sendPatches ? this.pickPatches(this.pendingPatches) : []

		this.hasPendingState = false
		this.needsFullState = false
		this.pendingPatches = []
		this.pendingDescription = undefined

		if (sendPatches) {
			if (patches.length > 0) {
				this.sendData({ type: 'patches', patches, description })
			}

			return
		}

		this.sendData({
			type: 'state_update',
			state: this.pickState(this.host.getState()),
			description,
		})
	}

	private pickState(state: T): Partial<T> {
		return this.config.pick ? this.config.pick(state) : state
	}

	private getPickedKeys(): Set<string> | null {
		return this.config.pick
			? new Set(Object.keys(this.config.pick(this.host.getState())))
			: null
	}

	private pickPatches(patches: Patch[]): Patch[] {
		const keys = this.getPickedKeys()

		return keys
			? patches.filter(patch => patch.path.length > 0 && keys.has(String(patch.path[0])))
			: patches
	}

	private getNextTimestamp(): number {
		this.clock = Math.max(Date.now(), this.clock + 1)

		return this.clock
	}

	private sendData(
		fields: Pick<SyncMessage<T>, 'type' | 'state' | 'patches' | 'description'>,
	): void {
		const message: SyncMessage<T> = {
			...fields,
			channel: this.config.channel,
			instanceId: this.instanceId,
			timestamp: this.getNextTimestamp(),
		}

		this.lastSent = { timestamp: message.timestamp, instanceId: this.instanceId }
		this.send(message)
	}

	private requestFullSync(): void {
		this.send({
			type: 'full_sync',
			channel: this.config.channel,
			instanceId: this.instanceId,
			timestamp: Date.now(),
		})
	}

	private broadcastFullState(): void {
		if (this.config.ignoreLocalChanges) {
			return
		}

		this.sendData({ type: 'state_update', state: this.pickState(this.host.getState()) })
	}

	private send(message: SyncMessage<T>): void {
		try {
			this.transport.send(message)
		} catch (error) {
			this.host.onError(toStoreError(error, 'SYNC_FAILED', 'Failed to send sync message'))
		}
	}

	/*
	 * INBOUND
	 */
	private reject(reason: string): false {
		this.host.onError(new StoreError(`Sync rejected a message: ${reason}`, 'SYNC_REJECTED'))

		return false
	}

	private handleMessage(raw: unknown): void {
		if (!isStateObject(raw)) {
			this.reject('invalid message structure')

			return
		}

		const message = raw as unknown as SyncMessage<T>

		// Another store's traffic on a shared transport is not ours to read
		if (message.channel !== this.config.channel) {
			return
		}

		if (typeof message.instanceId !== 'string') {
			this.reject('missing instance id')

			return
		}

		// Resync requests carry no state and skip clock checks, because a
		// clock-skewed client still needs to be able to ask for a resync
		if (message.type === 'full_sync') {
			if (message.instanceId !== this.instanceId) {
				this.broadcastFullState()
			}

			return
		}

		// A store that sends whole states has no use for patches, and applying them is a way to
		// touch state it never agreed to share
		if (message.type === 'patches' && this.config.mode === 'state') {
			this.reject('patches are not accepted in state mode')

			return
		}

		if (message.version !== undefined) {
			if (!Number.isSafeInteger(message.version) || message.version < 0) {
				this.reject('invalid version')

				return
			}

			this.handleVersionedMessage(message, message.version)

			return
		}

		if (message.instanceId === this.instanceId) {
			return
		}

		this.handleUnversionedMessage(message)
	}

	private handleUnversionedMessage(message: SyncMessage<T>): void {
		if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) {
			this.reject('missing or invalid timestamp')

			return
		}

		if (Math.abs(message.timestamp - Date.now()) > this.config.maxClockSkewMs) {
			this.reject(
				'timestamp is outside the clock skew tolerance. If peers run on devices with skewed clocks, raise maxClockSkewMs',
			)

			return
		}

		// Seeing a peer's stamp moves our clock past it, so our next message always wins over
		// anything we have already read, even from a peer with a fast clock
		this.clock = Math.max(this.clock, message.timestamp)

		const stamp: Stamp = { timestamp: message.timestamp, instanceId: message.instanceId }

		if (!isNewer(stamp, this.lastApplied)) {
			return
		}

		// Our own change is newer than this one, or about to be, so it wins and the sender gets it
		// next. Patches can't be merged over a state the sender never saw, so send the whole state
		const isConflict =
			this.hasPending() || (this.lastSent !== null && !isNewer(stamp, this.lastSent))

		if (isConflict) {
			if (this.config.mode === 'patches') {
				this.needsFullState = true
				this.scheduleFlush()
			}

			return
		}

		if (this.applyMessage(message)) {
			this.lastApplied = stamp
		}
	}

	private handleVersionedMessage(message: SyncMessage<T>, version: number): void {
		if (this.lastVersion !== null && version <= this.lastVersion) {
			return
		}

		// The server echoes our own messages back. Advance the cursor without
		// applying, otherwise every change we make would look like a version gap.
		if (message.instanceId === this.instanceId) {
			this.lastVersion = version

			return
		}

		// Gapped patches build on state we never received. A full state_update
		// is self-contained, so gaps only matter for patches.
		const hasGap = this.lastVersion !== null && version > this.lastVersion + 1

		if (hasGap && message.type === 'patches') {
			this.requestResync()

			return
		}

		if (this.applyMessage(message)) {
			this.lastVersion = version
		}
	}

	private requestResync(): void {
		if (!this.resyncPending) {
			this.resyncPending = true
			this.requestFullSync()
		}
	}

	private applyMessage(message: SyncMessage<T>): boolean {
		try {
			let applied = false

			switch (message.type) {
				case 'state_update':
					applied = this.applyState(message.state)
					break
				case 'patches':
					applied = this.applyRemotePatches(message.patches)
					break
				default:
					// The type is peer-controlled, so it stays out of the message
					this.reject('unknown message type')
			}

			if (message.type === 'state_update' && applied) {
				this.resyncPending = false
			}

			// A patch we couldn't take leaves us behind the sender, so ask for the whole state
			if (!applied && message.type === 'patches') {
				this.requestResync()
			}

			return applied
		} catch (error) {
			// A well-formed patch that doesn't fit is what a concurrent edit looks like. The resync
			// below fixes it, so it isn't an error
			if (!(error instanceof StoreError && error.code === 'PATCH_CONFLICT')) {
				this.host.onError(toStoreError(error, 'SYNC_REJECTED', 'Sync rejected a message'))
			}

			if (message.type === 'patches') {
				this.requestResync()
			}

			return false
		}
	}

	private applyState(incoming: Partial<T> | undefined): boolean {
		if (!isStateObject(incoming)) {
			return this.reject('invalid state')
		}

		if (hasProtoKey(incoming)) {
			return this.reject('state contains a "__proto__" key')
		}

		const current = this.host.getState()
		const keys = this.getPickedKeys()
		let next = incoming as T

		if (keys) {
			const merged = { ...current } as Record<string, unknown>

			for (const key of keys) {
				if (Object.hasOwn(incoming, key)) {
					merged[key] = (incoming as Record<string, unknown>)[key]
				}
			}

			next = merged as T
		}

		const { patches } = diffState(current, next)

		return patches.length === 0 || this.host.applyRemote(next, patches)
	}

	private applyRemotePatches(incoming: Patch[] | undefined): boolean {
		if (!Array.isArray(incoming)) {
			return this.reject('invalid patches')
		}

		if (incoming.some(patch => hasProtoKey((patch as Patch | null)?.value))) {
			return this.reject('patch value contains a "__proto__" key')
		}

		const patches = this.pickPatches(incoming)

		if (patches.length === 0) {
			return true
		}

		const next = applyPatches(this.host.getState(), patches)

		if (!isStateObject(next)) {
			return this.reject('patches would leave the state as a non-object')
		}

		return this.host.applyRemote(next, patches)
	}

	public destroy(): void {
		if (this.syncTimer) {
			clearTimeout(this.syncTimer)
			this.syncTimer = null
		}

		// Send what's still buffered so peers don't lose the final change
		this.flushPending()

		this.transport.destroy()
	}
}
