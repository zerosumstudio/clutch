import { describe, it, expect } from 'vitest'
import { enablePatches, produce, type Draft } from 'immer'
import { applyPatches, deepFreeze, diffState, hasProtoKey, type Patch } from '../patch'

enablePatches()

interface Shape {
	list: number[]
	nested: { a: { b: number[]; c: string }; tags: string[] }
	users: { id: number; name: string }[]
	flag: boolean
	extra?: string
}

const base = (): Shape => ({
	list: [1, 2, 3, 4],
	nested: { a: { b: [10, 20], c: 'x' }, tags: ['t1', 't2'] },
	users: [
		{ id: 1, name: 'a' },
		{ id: 2, name: 'b' },
	],
	flag: false,
})

// Each recipe is a change immer knows how to describe. Immer is the oracle: our applier has to
// turn its patches into the same state, forward and inverse
const recipes: Record<string, (draft: Draft<Shape>) => void> = {
	push: d => {
		d.list.push(5)
	},
	pop: d => {
		d.list.pop()
	},
	shift: d => {
		d.list.shift()
	},
	unshift: d => {
		d.list.unshift(0)
	},
	'splice remove and insert': d => {
		d.list.splice(1, 2, 9, 9, 9)
	},
	'length truncate': d => {
		d.list.length = 1
	},
	reverse: d => {
		d.list.reverse()
	},
	sort: d => {
		d.list.sort((a, b) => b - a)
	},
	'replace by index': d => {
		d.list[2] = 99
	},
	'nested object replace': d => {
		d.nested.a.c = 'changed'
	},
	'nested array push': d => {
		d.nested.a.b.push(30)
	},
	'add key': d => {
		d.extra = 'new'
	},
	'delete key': d => {
		delete (d as { extra?: string }).extra
		delete (d.nested as { tags?: string[] }).tags
	},
	'edit an array item field': d => {
		d.users[1]!.name = 'renamed'
	},
	'remove an array item': d => {
		d.users.splice(0, 1)
	},
	'subtree replace': d => {
		d.nested = { a: { b: [], c: '' }, tags: [] }
	},
	'several changes at once': d => {
		d.flag = true
		d.list.push(7)
		d.users.push({ id: 3, name: 'c' })
		d.nested.a.b[0] = 11
	},
}

describe('applyPatches against immer', () => {
	it.each(Object.entries(recipes))('%s: forward and inverse', (_name, recipe) => {
		const start = base()
		let patches: Patch[] = []
		let inverse: Patch[] = []
		const next = produce(start, recipe, (p, ip) => {
			patches = p
			inverse = ip
		})

		const forward = applyPatches(start, patches)
		expect(forward).toEqual(next)

		const back = applyPatches(next, inverse)
		expect(back).toEqual(start)
	})

	it('replaces the root', () => {
		expect(applyPatches({ other: 1 }, [{ op: 'replace', path: [], value: { x: 1 } }])).toEqual({
			x: 1,
		})
	})

	it('does not touch its input', () => {
		const start = deepFreeze(base())

		const next = applyPatches(start, [{ op: 'add', path: ['list', 0], value: 0 }])

		expect(start.list).toEqual([1, 2, 3, 4])
		expect(next.list).toEqual([0, 1, 2, 3, 4])
		expect(next.users).toBe(start.users)
	})
})

describe('applyPatches safety', () => {
	it('rejects __proto__ as a path segment', () => {
		expect(() =>
			applyPatches({}, [{ op: 'add', path: ['__proto__', 'polluted'], value: true }]),
		).toThrow('Invalid patch path segment')
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})

	it('rejects segments that are not strings or finite numbers', () => {
		for (const segment of [['x'], { toString: () => 'x' }, null, undefined, NaN, Infinity]) {
			expect(() =>
				applyPatches({ x: 1 }, [
					{ op: 'replace', path: [segment as unknown as string], value: 2 },
				]),
			).toThrow('Invalid patch path segment')
		}
	})

	it('treats constructor and prototype as ordinary data keys', () => {
		const next = applyPatches({ counts: {} }, [
			{ op: 'add', path: ['counts', 'constructor'], value: 1 },
			{ op: 'add', path: ['counts', 'prototype'], value: 2 },
		])

		expect(Object.keys(next.counts)).toEqual(['constructor', 'prototype'])
		expect(next.counts.constructor).toBe(1)
		expect(Object.getPrototypeOf(next.counts)).toBe(Object.prototype)
	})

	it('does not walk inherited properties', () => {
		expect(() =>
			applyPatches({ a: {} }, [
				{ op: 'add', path: ['a', 'constructor', 'name'], value: 'x' },
			]),
		).toThrow('Patch path does not exist')
		expect(Object.name).toBe('Object')
	})

	it('rejects paths that do not exist, bad indexes and unknown ops', () => {
		const state = { list: [1], obj: { a: 1 } }

		expect(() => applyPatches(state, [{ op: 'add', path: ['nope', 'x'], value: 1 }])).toThrow()
		expect(() =>
			applyPatches(state, [{ op: 'replace', path: ['list', 5], value: 1 }]),
		).toThrow()
		expect(() => applyPatches(state, [{ op: 'add', path: ['list', 9], value: 1 }])).toThrow()
		expect(() => applyPatches(state, [{ op: 'add', path: ['list', -1], value: 1 }])).toThrow()
		expect(() => applyPatches(state, [{ op: 'add', path: ['list', 'x'], value: 1 }])).toThrow()
		expect(() => applyPatches(state, [{ op: 'remove', path: [] }])).toThrow()
		expect(() =>
			applyPatches(state, [{ op: 'move' as unknown as 'add', path: ['list'], value: 1 }]),
		).toThrow('Invalid patch structure')
		expect(() => applyPatches(state, [null as unknown as Patch])).toThrow('Invalid patch')
		expect(() => applyPatches(state, [{ op: 'add', path: 'list' as never }])).toThrow()
	})

	it('rejects an invalid array length', () => {
		expect(() =>
			applyPatches({ list: [1] }, [{ op: 'replace', path: ['list', 'length'], value: -1 }]),
		).toThrow('Invalid array length')
	})

	it('accepts numeric string indexes for arrays', () => {
		expect(
			applyPatches({ list: [1, 2] }, [{ op: 'replace', path: ['list', '1'], value: 9 }]),
		).toEqual({ list: [1, 9] })
	})
})

describe('diffState', () => {
	it('describes added, changed and removed top-level keys with inverses', () => {
		const before = { a: 1, b: 2, c: 3 }
		const after = { a: 1, b: 20, d: 4 }

		const { patches, inversePatches } = diffState(before, after)

		expect(applyPatches(before, patches)).toEqual(after)
		expect(applyPatches(after, inversePatches)).toEqual(before)
	})

	it('returns nothing when the values are the same', () => {
		const shared = { x: 1 }

		expect(diffState({ a: shared }, { a: shared }).patches).toEqual([])
	})

	it('does not treat an inherited name as an existing key', () => {
		const { patches, inversePatches } = diffState({ a: 1 }, { a: 1, toString: 'x' })

		expect(patches).toEqual([{ op: 'add', path: ['toString'], value: 'x' }])
		expect(inversePatches).toEqual([{ op: 'remove', path: ['toString'] }])
	})
})

describe('deepFreeze', () => {
	it('freezes plain objects and arrays all the way down', () => {
		const value = deepFreeze({ a: { b: [{ c: 1 }] } })

		expect(Object.isFrozen(value)).toBe(true)
		expect(Object.isFrozen(value.a.b)).toBe(true)
		expect(Object.isFrozen(value.a.b[0])).toBe(true)
	})

	it('leaves class instances, dates and maps alone', () => {
		const date = new Date()
		const map = new Map()
		class Thing {
			x = 1
		}
		const thing = new Thing()

		deepFreeze({ date, map, thing })

		expect(Object.isFrozen(date)).toBe(false)
		expect(Object.isFrozen(map)).toBe(false)
		expect(Object.isFrozen(thing)).toBe(false)
	})

	it('skips subtrees that are already frozen', () => {
		const inner = Object.freeze({ x: { y: 1 } })

		deepFreeze({ inner })

		expect(Object.isFrozen(inner.x)).toBe(false)
	})

	it('survives cycles', () => {
		const a: Record<string, unknown> = {}
		a.self = a

		expect(() => deepFreeze(a)).not.toThrow()
		expect(Object.isFrozen(a)).toBe(true)
	})
})

describe('hasProtoKey', () => {
	it('finds an own __proto__ key at any depth, and nothing else', () => {
		expect(hasProtoKey(JSON.parse('{"a":[{"__proto__":{}}]}'))).toBe(true)
		expect(hasProtoKey({ a: { constructor: 1, prototype: 2 } })).toBe(false)
		expect(hasProtoKey({ a: '__proto__' })).toBe(false)
		expect(hasProtoKey(null)).toBe(false)
	})

	it('survives cycles', () => {
		const a: Record<string, unknown> = {}
		a.self = a

		expect(hasProtoKey(a)).toBe(false)
	})
})

describe('length patches', () => {
	it('rejects a length that grows the array, so a tiny patch cannot allocate billions of slots', () => {
		const state = { list: [1, 2, 3] }

		for (const value of [4294967295, 1e6, 4, 3.5, -1, '2', NaN]) {
			expect(() =>
				applyPatches(state, [{ op: 'replace', path: ['list', 'length'], value }]),
			).toThrow('Invalid array length in patch')
		}
	})

	it('still allows a length that shrinks or stays', () => {
		expect(
			applyPatches({ list: [1, 2, 3] }, [
				{ op: 'replace', path: ['list', 'length'], value: 1 },
			]),
		).toEqual({
			list: [1],
		})
		expect(
			applyPatches({ list: [1, 2, 3] }, [
				{ op: 'replace', path: ['list', 'length'], value: 3 },
			]),
		).toEqual({
			list: [1, 2, 3],
		})
	})

	it('does not let growing patches chain into a huge array through adds', () => {
		expect(() =>
			applyPatches({ list: [] as number[] }, [
				{ op: 'add', path: ['list', 4294967294], value: 1 },
			]),
		).toThrow('Array index out of range in patch')
	})
})

describe('patch conflicts', () => {
	it('tells a patch that no longer fits apart from one that is invalid', () => {
		const state = { list: [1], obj: {} }

		for (const patch of [
			{ op: 'replace', path: ['list', 5], value: 1 },
			{ op: 'add', path: ['list', 9], value: 1 },
			{ op: 'add', path: ['missing', 'x'], value: 1 },
		] as Patch[]) {
			expect(() => applyPatches(state, [patch])).toThrow(
				expect.objectContaining({ code: 'PATCH_CONFLICT' }),
			)
		}

		for (const patch of [
			{ op: 'add', path: ['__proto__', 'x'], value: 1 },
			{ op: 'nope', path: ['list'], value: 1 },
			{ op: 'replace', path: ['list', 'length'], value: 99 },
		] as Patch[]) {
			expect(() => applyPatches(state, [patch])).toThrow(
				expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
			)
		}
	})
})

describe('deepFreeze depth', () => {
	it('handles a value nested far deeper than the call stack allows', () => {
		let value: Record<string, unknown> = {}
		const root = value

		for (let level = 0; level < 100_000; level++) {
			const next: Record<string, unknown> = {}
			value.child = next
			value = next
		}

		expect(() => deepFreeze(root)).not.toThrow()
		expect(Object.isFrozen(root)).toBe(true)
		expect(Object.isFrozen(value)).toBe(true)
	})
})
