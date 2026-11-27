/*
 *   TYPES
 ***************************************************************************************************/
export type StoreErrorCode =
	| 'INVALID_ARGUMENT'
	| 'VALIDATION_FAILED'
	| 'PATCH_CONFLICT'
	| 'DESTROYED'
	| 'DUPLICATE_PLUGIN'
	| 'EXTENSION_COLLISION'
	| 'PERSISTENCE_FAILED'
	| 'AUTOSAVE_FAILED'
	| 'SYNC_REJECTED'
	| 'SYNC_FAILED'
	| 'DEVTOOLS_FAILED'
	| 'PLUGIN_FAILED'

/*
 *   STORE ERROR
 ***************************************************************************************************/
export class StoreError extends Error {
	public readonly code: StoreErrorCode

	constructor(message: string, code: StoreErrorCode, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'StoreError'
		this.code = code
	}
}

/**
 * Makes sure `onError` gets a StoreError with a code. Without a `message`, a StoreError passes
 * through as it is. With one, anything is wrapped under the new code, keeping the original on
 * `cause`.
 */
export function toStoreError(value: unknown, code: StoreErrorCode, message?: string): StoreError {
	if (value instanceof StoreError && message === undefined) {
		return value
	}

	const reason = value instanceof Error ? value.message : String(value)

	return new StoreError(message ? `${message}: ${reason}` : reason, code, { cause: value })
}
