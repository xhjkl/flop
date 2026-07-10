export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: 'stun:stun.cloudflare.com:3478' },
]

// STUN helps peers find each other; it is not a relay and should not become a server path.
export const ICE_GATHER_TIMEOUT_MS = 2500
export const RELAY_ICE_GATHER_TIMEOUT_MS = 8000
export const DISCONNECT_GRACE_MS = 30_000

export const candidateTypeCounts = (sdp: string) => {
	// SDP is the browser's ledger. We only need the candidate flavors.
	const counts: Record<string, number> = {}

	for (const match of sdp.matchAll(/^a=candidate:.*\styp\s+(\S+)/gm)) {
		const type = match[1] ?? 'unknown'
		counts[type] = (counts[type] ?? 0) + 1
	}

	return counts
}

export const waitForIce = (
	pc: RTCPeerConnection,
	timeoutMs: number | null = null,
	isEnough: (pc: RTCPeerConnection) => boolean = (pc) =>
		pc.iceGatheringState === 'complete',
) => {
	// Copy-paste signaling gets one SDP. Wait until it has useful addresses.
	if (pc.iceGatheringState === 'complete') return Promise.resolve()
	if (isEnough(pc)) return Promise.resolve()

	return new Promise<void>((resolve) => {
		let timeoutId: ReturnType<typeof setTimeout> | null = null

		const cleanup = () => {
			pc.removeEventListener('icecandidate', handleCandidate)
			pc.removeEventListener('icegatheringstatechange', handleChange)
			pc.removeEventListener('signalingstatechange', handleSignalChange)
			if (timeoutId != null) clearTimeout(timeoutId)
		}

		const maybeResolve = () => {
			// "Enough" lets the UI move once the SDP can probably work.
			if (pc.iceGatheringState !== 'complete' && !isEnough(pc)) return
			cleanup()
			resolve()
		}

		const handleCandidate = () => {
			maybeResolve()
		}

		const handleChange = () => {
			maybeResolve()
		}

		const handleSignalChange = () => {
			// Closed peers should not leave callers waiting for ICE that cannot arrive.
			if (pc.signalingState !== 'closed') return
			cleanup()
			resolve()
		}

		pc.addEventListener('icecandidate', handleCandidate)
		pc.addEventListener('icegatheringstatechange', handleChange)
		pc.addEventListener('signalingstatechange', handleSignalChange)

		if (timeoutMs != null) {
			timeoutId = setTimeout(() => {
				cleanup()
				resolve()
			}, timeoutMs)
		}
	})
}

/** Server-reflexive or relay address suitable for non-trickle signaling. */
export const hasServerReflexiveOrRelayCandidate = (pc: RTCPeerConnection) => {
	const counts = candidateTypeCounts(pc.localDescription?.sdp ?? '')
	return counts.srflx != null || counts.relay != null
}
