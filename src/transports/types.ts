/*
 *   SYNC TRANSPORT INTERFACE
 ***************************************************************************************************/
export type TransportStatus = 'connecting' | 'connected' | 'disconnected'

export interface SyncTransport {
	send(message: unknown): void
	onMessage(handler: (message: unknown) => void): void
	// 'connected' triggers a full resync in the sync manager
	onStatusChange?(handler: (status: TransportStatus) => void): void
	// Transport failures, so they reach the store's `onError`
	onError?(handler: (error: unknown) => void): void
	// If absent, the transport is live on construction
	start?(): void
	destroy(): void
}
