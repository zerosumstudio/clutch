/*
 *   IMPORTS
 ***************************************************************************************************/
import { StoreError } from './error'

/*
 *   TYPES
 ***************************************************************************************************/
export interface Patch {
	op: 'add' | 'replace' | 'remove'
	path: (string | number)[]
	value?: unknown
}

export interface PatchSet {
	patches: Patch[]
	inversePatches: Patch[]
}

type Container = Record<string, unknown> | unknown[]

/*
 *   HELPERS
 ***************************************************************************************************/
export function isStateObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!isStateObject(value)) {
		return false
	}

	const proto: unknown = Object.getPrototypeOf(value)

	return proto === Object.prototype || proto === null
}

/** True when an own `__proto__` key sits anywhere in the value, which only JSON and cloning produce. */
export function hasProtoKey(root: unknown): boolean {
	const stack: unknown[] = [root]
	const seen: WeakSet<object> = new WeakSet()

	while (stack.length > 0) {
		const value = stack.pop()

		if (!value || typeof value !== 'object' || seen.has(value)) {
			continue
		}

		seen.add(value)

		for (const key of Object.keys(value)) {
			if (key === '__proto__') {
				return true
			}

			stack.push((value as Container)[key as never])
		}
	}

	return false
}

/*
 *   FREEZE
 ***************************************************************************************************/
/**
 * Freezes plain objects and arrays in place, skipping subtrees that are already frozen. Iterative,
 * so a deeply nested value can't overflow the stack.
 */
export function deepFreeze<T>(root: T): T {
	const stack: unknown[] = [root]

	while (stack.length > 0) {
		const value = stack.pop()

		if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
			continue
		}

		if (!Array.isArray(value) && !isPlainObject(value)) {
			continue
		}

		Object.freeze(value)

		for (const key of Object.keys(value)) {
			stack.push((value as Container)[key as never])
		}
	}

	return root
}

/*
 *   DIFF
 ***************************************************************************************************/
/** Top-level key diff, with the inverse that restores each key's whole previous value. */
export function diffState(previous: object, next: object): PatchSet {
	const before = previous as Record<string, unknown>
	const after = next as Record<string, unknown>
	const patches: Patch[] = []
	const inversePatches: Patch[] = []

	for (const key of Object.keys(after)) {
		const existed = Object.hasOwn(before, key)

		if (existed && Object.is(before[key], after[key])) {
			continue
		}

		patches.push({ op: existed ? 'replace' : 'add', path: [key], value: after[key] })
		inversePatches.push(
			existed
				? { op: 'replace', path: [key], value: before[key] }
				: { op: 'remove', path: [key] },
		)
	}

	for (const key of Object.keys(before)) {
		if (!Object.hasOwn(after, key)) {
			patches.push({ op: 'remove', path: [key] })
			inversePatches.push({ op: 'add', path: [key], value: before[key] })
		}
	}

	return { patches, inversePatches }
}

/*
 *   APPLY
 ***************************************************************************************************/
function throwInvalid(message: string): never {
	throw new StoreError(message, 'INVALID_ARGUMENT')
}

/** A well-formed patch that doesn't fit the current state, which is what a concurrent edit causes. */
function throwConflict(message: string): never {
	throw new StoreError(message, 'PATCH_CONFLICT')
}

function readSegment(segment: unknown): string | number {
	if (typeof segment === 'number' && Number.isFinite(segment)) {
		return segment
	}

	// Segments only ever address own keys, so `constructor` and `prototype` are plain data.
	// `__proto__` is the one name that could reach a prototype
	if (typeof segment === 'string' && segment !== '__proto__') {
		return segment
	}

	return throwInvalid('Invalid patch path segment')
}

function readIndex(segment: string | number): number {
	let index = -1

	if (typeof segment === 'number') {
		index = segment
	} else if (/^\d+$/.test(segment)) {
		index = Number(segment)
	}

	return Number.isInteger(index) && index >= 0
		? index
		: throwInvalid('Invalid array index in patch')
}

function applyToArray(
	node: unknown[],
	segment: string | number,
	last: boolean,
	patch: Patch,
	descend: () => unknown,
): unknown[] {
	const copy = node.slice()

	if (segment === 'length') {
		const length = patch.value

		// Only shrinking, which is all immer emits. Growing would let a tiny patch allocate a
		// sparse array of billions of slots
		const isShrink =
			Number.isInteger(length) && (length as number) >= 0 && (length as number) <= node.length

		if (!last || patch.op === 'remove' || !isShrink) {
			throwInvalid('Invalid array length in patch')
		}

		copy.length = length as number

		return copy
	}

	const index = readIndex(segment)

	if (!last) {
		if (index >= node.length) {
			throwConflict('Patch path does not exist')
		}

		copy[index] = descend()

		return copy
	}

	if (patch.op === 'add') {
		if (index > copy.length) {
			throwConflict('Array index out of range in patch')
		}

		copy.splice(index, 0, patch.value)

		return copy
	}

	if (index >= copy.length) {
		throwConflict('Array index out of range in patch')
	}

	if (patch.op === 'replace') {
		copy[index] = patch.value
	} else {
		copy.splice(index, 1)
	}

	return copy
}

function applyToObject(
	node: Record<string, unknown>,
	key: string,
	last: boolean,
	patch: Patch,
	descend: () => unknown,
): Record<string, unknown> {
	const copy = { ...node }

	if (!last) {
		if (!Object.hasOwn(node, key)) {
			throwConflict('Patch path does not exist')
		}

		copy[key] = descend()
	} else if (patch.op === 'remove') {
		const { [key]: _removed, ...rest } = copy

		return rest
	} else {
		copy[key] = patch.value
	}

	return copy
}

function applyAt(node: unknown, depth: number, patch: Patch): unknown {
	if (depth === patch.path.length) {
		return patch.op === 'remove'
			? throwInvalid('Cannot remove the root of the state')
			: patch.value
	}

	const segment = readSegment(patch.path[depth])
	const last = depth === patch.path.length - 1
	const descend = (): unknown => applyAt((node as Container)[segment as never], depth + 1, patch)

	if (Array.isArray(node)) {
		return applyToArray(node, segment, last, patch, descend)
	}

	if (isPlainObject(node)) {
		return applyToObject(node, String(segment), last, patch, descend)
	}

	return throwConflict('Patch path does not exist')
}

// Patches can come off the wire, so their shape is checked rather than trusted
function isPatch(value: unknown): value is Patch {
	if (typeof value !== 'object' || value === null) {
		return false
	}

	const { op, path } = value as { op?: unknown; path?: unknown }

	return Array.isArray(path) && (op === 'add' || op === 'replace' || op === 'remove')
}

/**
 * Applies patches copy-on-write to plain objects and arrays. Segments must be strings or finite
 * numbers and only address own keys. Throws an INVALID_ARGUMENT on anything it can't apply.
 */
export function applyPatches<T>(state: T, patches: readonly Patch[]): T {
	let next: unknown = state

	for (const patch of patches as readonly unknown[]) {
		if (!isPatch(patch)) {
			throwInvalid('Invalid patch structure')
		}

		next = applyAt(next, 0, patch)
	}

	return next as T
}
