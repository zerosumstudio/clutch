/*
 *   IMPORTS
 ***************************************************************************************************/
import type { Plugin, PluginContext } from '../core'
import { StoreError } from '../error'
import { isStandardSchema, parseSchema, type StandardSchemaV1 } from './standard-schema'

/*
 *   TYPES
 ***************************************************************************************************/
export type StateValidator<T> = (state: T) => boolean | string

// What a failed check says, without the "State validation failed" every error starts with
type Check<T> = (state: T) => true | { detail: string | undefined; cause?: unknown }

const VALIDATE_SOURCE = 'validate'

/*
 *   PLUGIN
 ***************************************************************************************************/
export function validate<T extends object>(
	validator: StateValidator<T> | StandardSchemaV1<T>,
): Plugin<T> {
	const check = toCheck(validator)

	let ctx: PluginContext<T> | null = null

	return {
		name: VALIDATE_SOURCE,

		onInit(context) {
			ctx = context
		},

		onBeforeCommit(payload) {
			const result = check(payload.state)

			if (result !== true) {
				throw new StoreError(
					describeFailure('State validation failed', result.detail),
					'VALIDATION_FAILED',
					{
						cause: result.cause,
					},
				)
			}
		},

		onExternalState(state, meta) {
			const result = check(state)

			if (result === true) {
				return
			}

			ctx?.emitError(
				new StoreError(
					describeFailure(
						`State validation failed for external update from "${meta.source}"`,
						result.detail,
					),
					'VALIDATION_FAILED',
					{ cause: result.cause },
				),
				VALIDATE_SOURCE,
			)
		},

		onDestroy() {
			ctx = null
		},
	}
}

/*
 *   HELPERS
 ***************************************************************************************************/
function describeFailure(summary: string, detail: string | undefined): string {
	return detail ? `${summary}: ${detail}` : summary
}

/** Normalizes a function or a Standard Schema into one check. */
function toCheck<T extends object>(validator: StateValidator<T> | StandardSchemaV1<T>): Check<T> {
	if (isStandardSchema<T>(validator)) {
		return state => {
			const result = parseSchema(validator, state)

			return result.ok ? true : { detail: result.message, cause: result.issues }
		}
	}

	if (typeof validator === 'function') {
		return state => {
			const result = validator(state)

			if (typeof result === 'string') {
				return { detail: result || undefined }
			}

			return result ? true : { detail: undefined }
		}
	}

	throw new StoreError('Validator must be a function or a Standard Schema', 'INVALID_ARGUMENT')
}
