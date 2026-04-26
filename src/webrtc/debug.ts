export function debugValue(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return {
			message: value.message,
			name: value.name,
		}
	}

	return value
}

export function rtcDebug(event: string, details: Record<string, unknown> = {}) {
	console.debug('[flop:rtc]', JSON.stringify({ event, ...details }, debugValue))
}

export type RtcDebug = typeof rtcDebug
