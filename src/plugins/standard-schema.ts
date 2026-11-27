/*
 *   IMPORTS
 ***************************************************************************************************/
import { StoreError } from '../error'

/*
 *   TYPES
 ***************************************************************************************************/
/**
 * The subset of the Standard Schema v1 spec clutch needs. Any compliant
 * validator (zod, valibot, arktype, ...) satisfies it structurally, so plugins
 * take a schema without depending on a specific library.
 */
export interface StandardSchemaV1<Output = unknown> {
	readonly '~standard': {
		readonly version: 1
		readonly vendor: string
		readonly validate: (
			value: unknown,
		) => StandardResult<Output> | Promise<StandardResult<Output>>
	}
}

interface StandardIssue {
	readonly message: string
	readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

type StandardResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<StandardIssue> }

export type SchemaResult<Output> =
	| { ok: true; value: Output }
	| { ok: false; message: string; issues: ReadonlyArray<StandardIssue> }

const MAX_REPORTED_PATHS = 5
const MAX_PATH_CHARS = 40

/*
 *   HELPERS
 ***************************************************************************************************/
export function isStandardSchema<T>(value: unknown): value is StandardSchemaV1<T> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'~standard' in value &&
		typeof (value as Partial<StandardSchemaV1<T>>)['~standard']?.validate === 'function'
	)
}

function formatPath(issue: StandardIssue): string {
	const segments = (issue.path ?? []).map(segment =>
		String(typeof segment === 'object' ? segment.key : segment),
	)
	const path = segments.length > 0 ? segments.join('.') : '(root)'

	return path.length > MAX_PATH_CHARS ? `${path.slice(0, MAX_PATH_CHARS)}...` : path
}

// Issue messages can quote the value that failed and can be huge, so they stay out of the
// message. The raw issues travel on the error's `cause`
function formatIssues(issues: ReadonlyArray<StandardIssue>): string {
	const paths = issues.slice(0, MAX_REPORTED_PATHS).map(formatPath)
	const more = issues.length > MAX_REPORTED_PATHS ? ', ...' : ''
	const count = issues.length === 1 ? '1 issue' : `${issues.length} issues`

	return `${count} at ${paths.join(', ')}${more}`
}

/** Runs a schema and returns its output, so what it strips or coerces is what gets applied. */
export function parseSchema<T>(schema: StandardSchemaV1<T>, value: unknown): SchemaResult<T> {
	const result = schema['~standard'].validate(value)

	if (typeof (result as Promise<unknown> | null)?.then === 'function') {
		// Nobody awaits it, so a rejection would go unhandled and could take the process down
		;(result as Promise<unknown>).then(undefined, () => {})

		throw new StoreError(
			'Async schema validation is not supported; state updates are synchronous',
			'INVALID_ARGUMENT',
		)
	}

	const settled = result as StandardResult<T>

	if (settled.issues) {
		const issues = settled.issues.length > 0 ? settled.issues : [{ message: 'invalid' }]

		return { ok: false, message: formatIssues(issues), issues }
	}

	return { ok: true, value: settled.value }
}
