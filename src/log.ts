const normalizeLogValue = (
	value: unknown,
	seen = new WeakSet<object>(),
): unknown => {
	if (value instanceof Error) {
		return { message: value.message, name: value.name }
	}

	if (typeof Event !== 'undefined' && value instanceof Event) {
		return { type: value.type }
	}

	if (Array.isArray(value)) {
		return value.map((item) => normalizeLogValue(item, seen))
	}

	if (typeof value !== 'object' || value == null) return value

	if (seen.has(value)) return '[circular]'
	seen.add(value)

	const output: Record<string, unknown> = {}
	for (const [key, item] of Object.entries(value)) {
		output[key] = normalizeLogValue(item, seen)
	}

	return output
}

const logLine = (event: string, details: Record<string, unknown>) => {
	return JSON.stringify(normalizeLogValue({ event, ...details }))
}

export const warnLog = (
	scope: string,
	event: string,
	details: Record<string, unknown> = {},
) => {
	console.warn(`[flop:${scope}] ${logLine(event, details)}`)
}

export const infoLog = (
	scope: string,
	event: string,
	details: Record<string, unknown> = {},
) => {
	console.info(`[flop:${scope}] ${logLine(event, details)}`)
}

export const errorLog = (
	scope: string,
	event: string,
	details: Record<string, unknown> = {},
) => {
	console.error(`[flop:${scope}] ${logLine(event, details)}`)
}
