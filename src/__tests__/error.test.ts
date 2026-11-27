import { describe, expect, it } from 'vitest'
import { StoreError, toStoreError } from '../error'

describe('toStoreError', () => {
	it('passes a StoreError through when there is no message to add', () => {
		const original = new StoreError('already typed', 'DESTROYED')

		expect(toStoreError(original, 'PLUGIN_FAILED')).toBe(original)
	})

	it('wraps a StoreError under the new code when it is given a message, keeping the original as the cause', () => {
		const original = new StoreError('index out of range', 'PATCH_CONFLICT')

		const wrapped = toStoreError(original, 'PLUGIN_FAILED', 'Undo failed')

		expect(wrapped).not.toBe(original)
		expect(wrapped.code).toBe('PLUGIN_FAILED')
		expect(wrapped.message).toBe('Undo failed: index out of range')
		expect(wrapped.cause).toBe(original)
	})

	it('wraps anything else, whatever it is', () => {
		expect(toStoreError(new Error('boom'), 'SYNC_FAILED').message).toBe('boom')
		expect(toStoreError('text', 'SYNC_FAILED', 'Sync').message).toBe('Sync: text')
		expect(toStoreError(42, 'SYNC_FAILED').cause).toBe(42)
	})
})
