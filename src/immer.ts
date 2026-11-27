/*
 *   IMPORTS
 ***************************************************************************************************/
import { enablePatches, produce, type Draft } from 'immer'
import type { Plugin, PluginContext } from './core'
import { StoreError } from './error'
import type { Patch } from './patch'

export type { Draft }

/*
 *   TYPES
 ***************************************************************************************************/
export interface ImmerApi<T> {
	/**
	 * Like immer, a recipe changes the draft or returns a new state. It can't be async, since the
	 * draft is revoked before the rest of it would run and the change would be lost.
	 */
	mutate(recipe: (draft: Draft<T>) => void | T, description?: string): void
}

/*
 *   PLUGIN
 ***************************************************************************************************/
export function immer<T extends object>(): Plugin<T, ImmerApi<T>> {
	// Inside the factory so importing this entry has no side effects
	enablePatches()

	let ctx: PluginContext<T> | null = null

	const mutate = (recipe: (draft: Draft<T>) => void | T, description?: string): void => {
		if (!ctx) {
			throw new StoreError('Cannot operate on destroyed Store', 'DESTROYED')
		}

		if (typeof recipe !== 'function') {
			throw new StoreError('Recipe must be a function', 'INVALID_ARGUMENT')
		}

		let patches: Patch[] = []
		let inversePatches: Patch[] = []

		const next = produce(
			ctx.getState(),
			// Immer types what a recipe may return more narrowly than we do, and the compiler needs the cast
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
			recipe as unknown as (draft: Draft<T>) => void,
			(forward, inverse) => {
				patches = forward
				inversePatches = inverse
			},
		)

		if (patches.length === 0) {
			return
		}

		ctx.commit(next, { patches, inversePatches, description })
	}

	return {
		name: 'immer',

		onInit(context) {
			ctx = context

			return { mutate }
		},

		onDestroy() {
			ctx = null
		},
	}
}
