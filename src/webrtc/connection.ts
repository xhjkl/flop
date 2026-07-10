export type ConnectionHealth =
	| 'connected'
	| 'disconnected'
	| 'failed'
	| 'waiting'

/** One transport verdict from the browser's overlapping peer and ICE states. */
export const connectionHealth = (
	connectionState: RTCPeerConnectionState,
	iceConnectionState: RTCIceConnectionState,
): ConnectionHealth => {
	if (
		connectionState === 'failed' ||
		connectionState === 'closed' ||
		iceConnectionState === 'failed' ||
		iceConnectionState === 'closed'
	) {
		return 'failed'
	}

	if (
		connectionState === 'connected' ||
		iceConnectionState === 'connected' ||
		iceConnectionState === 'completed'
	) {
		return 'connected'
	}

	if (
		connectionState === 'disconnected' ||
		iceConnectionState === 'disconnected'
	) {
		return 'disconnected'
	}

	return 'waiting'
}
