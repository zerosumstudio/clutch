import { describe, expect, it } from 'vitest'
import { parseSchema, type StandardSchemaV1 } from '../plugins/standard-schema'

const schemaReturning = (
	result: ReturnType<StandardSchemaV1['~standard']['validate']>,
): StandardSchemaV1 => ({
	'~standard': { version: 1, vendor: 'test', validate: () => result },
})

describe('parseSchema', () => {
	it('returns the schema output, not the input', () => {
		const schema = schemaReturning({ value: { kept: 1 } })

		expect(parseSchema(schema, { kept: 1, stripped: 2 })).toEqual({
			ok: true,
			value: { kept: 1 },
		})
	})

	it('summarises issues by count and path, and keeps the raw issues', () => {
		const issues = [
			{ message: 'Invalid input: received "tok_live_SECRET"', path: ['session', 'token'] },
			{ message: 'bad', path: [{ key: 'items' }, 3] },
			{ message: 'no path' },
		]

		const result = parseSchema(schemaReturning({ issues }), {})

		expect(result).toMatchObject({
			ok: false,
			message: '3 issues at session.token, items.3, (root)',
		})
		expect(!result.ok && result.issues).toBe(issues)
		expect(JSON.stringify(!result.ok && result.message)).not.toContain('tok_live_SECRET')
	})

	it('caps how many paths, and how long each one is', () => {
		const issues = Array.from({ length: 50 }, (_, index) => ({
			message: 'x'.repeat(10_000),
			path: ['k'.repeat(500), index],
		}))

		const result = parseSchema(schemaReturning({ issues }), {})

		expect(!result.ok && result.message.length).toBeLessThan(400)
		expect(!result.ok && result.message).toContain('50 issues')
	})

	// Vitest fails the run on an unhandled rejection, so reaching the end proves there is none
	it('does not leave a rejecting async schema as an unhandled rejection', async () => {
		expect(() =>
			parseSchema(schemaReturning(Promise.reject(new Error('async boom'))), {}),
		).toThrow('Async schema validation is not supported')

		await new Promise(resolve => setTimeout(resolve, 10))
	})
})
