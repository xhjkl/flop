/** Single-line console diagnostics for text sinks and browser devtools. */
export const log = (
	method: 'error' | 'info' | 'warn',
	scope: string,
	event: string,
	details: Record<string, unknown> = {},
) => {
	const seen = new WeakSet<object>()
	const line = JSON.stringify({ event, ...details }, (_key, value) => {
		if (value instanceof Error) {
			return { message: value.message, name: value.name }
		}

		if (typeof Event !== 'undefined' && value instanceof Event) {
			return { type: value.type }
		}

		if (typeof value === 'bigint') return value.toString()
		if (typeof value !== 'object' || value == null) return value
		if (seen.has(value)) return '[circular]'

		seen.add(value)
		return value
	})

	console[method](`[flop:${scope}] ${line}`)
}
