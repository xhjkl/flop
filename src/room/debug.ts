export function roomDebug(
	event: string,
	details: Record<string, unknown> = {},
) {
	console.debug('[flop:room]', JSON.stringify({ event, ...details }))
}

export function mediaTracks(stream: MediaStream | null) {
	return (
		stream?.getTracks().map((track) => ({
			enabled: track.enabled,
			id: track.id,
			kind: track.kind,
			muted: track.muted,
			readyState: track.readyState,
		})) ?? []
	)
}
