import { defineConfig } from 'tsdown'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		react: 'src/react.ts',
		immer: 'src/immer.ts',
		'sync-ws': 'src/transports/websocket.ts',
	},
	format: 'esm',
	platform: 'neutral',
	target: 'es2022',
	dts: true,
	clean: true,
	minify: false,
	sourcemap: false,
	outDir: 'dist',
})
