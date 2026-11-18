import solid from '@solidjs/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [solid()],
	base: './',
	server: {
		proxy: {
			'/-': {
				target: 'http://127.0.0.1:8787',
				ws: true,
			},
		},
	},
	build: {
		target: 'esnext',
	},
})
