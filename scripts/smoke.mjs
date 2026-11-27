// Runs against the built package in dist, through the package's own exports map, so it catches
// what the unit tests can't: build output, entry wiring and ESM/require loading.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const NAME = '@zerosumstudio/clutch'

const calls = []
globalThis.window = globalThis
globalThis.__REDUX_DEVTOOLS_EXTENSION__ = {
	connect: config => {
		calls.push(['connect', config])

		return {
			init: state => calls.push(['init', state]),
			send: (action, state) => calls.push(['send', action, state]),
			subscribe: () => () => {},
			unsubscribe: () => {},
		}
	},
}

const main = await import(NAME)
const react = await import(`${NAME}/react`)
const immerEntry = await import(`${NAME}/immer`)
const syncWs = await import(`${NAME}/sync-ws`)

assert.equal(typeof main.createStore, 'function', 'main: createStore')
assert.equal(typeof main.createRegistry, 'function', 'main: createRegistry')
assert.equal(typeof main.sharedStore, 'function', 'main: sharedStore')
assert.equal(typeof main.shallowEqual, 'function', 'main: shallowEqual')
assert.equal(typeof main.StoreError, 'function', 'main: StoreError')
for (const plugin of ['history', 'persist', 'devtools', 'sync', 'validate', 'autosave']) {
	assert.equal(typeof main[plugin], 'function', `main: ${plugin}`)
}
for (const hook of ['useStore', 'useRegistry', 'useHistory', 'useHydration', 'useAutosave']) {
	assert.equal(typeof react[hook], 'function', `react: ${hook}`)
}
assert.equal(typeof react.createStoreScope, 'function', 'react: createStoreScope')
assert.equal(typeof immerEntry.immer, 'function', 'immer: immer')
assert.equal(typeof syncWs.WebSocketTransport, 'function', 'sync-ws: WebSocketTransport')

// Core works without immer, and the immer entry adds mutate on top
const plain = main.createStore({ initialState: { count: 0 } })
plain.set(state => ({ count: state.count + 1 }))
assert.equal(plain.getState().count, 1)
assert.equal(plain.mutate, undefined)

const store = main
	.createStore({ initialState: { count: 0, list: [] } })
	.with(immerEntry.immer())
	.with(main.history())
	.with(main.devtools({ name: 'smoke' }))

store.mutate(draft => {
	draft.count += 1
	draft.list.push('a')
}, 'bump')
assert.deepEqual(store.getState(), { count: 1, list: ['a'] })
assert.equal(store.undo(), true)
assert.deepEqual(store.getState(), { count: 0, list: [] })

// The devtools bug this guards: a build that renames the extension property never connects
assert.equal(calls.filter(([kind]) => kind === 'connect').length, 1, 'devtools: connect called')
assert.ok(
	calls.some(([kind, action]) => kind === 'send' && action.type === 'bump'),
	'devtools: commit sent',
)

// require() of the ESM entry
const require = createRequire(import.meta.url)
const required = require(NAME)
assert.equal(typeof required.createStore, 'function', 'require: createStore')
assert.equal(required.StoreError, main.StoreError, 'require: same module instance as import')
assert.equal(typeof require(`${NAME}/immer`).immer, 'function', 'require: immer entry')

store.destroy()
plain.destroy()
console.log('smoke ok')
