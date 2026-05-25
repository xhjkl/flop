import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

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
