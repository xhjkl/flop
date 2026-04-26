export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: 'stun:stun.cloudflare.com:3478' },
]

// STUN helps peers find each other; it is not a relay and should not become a server path.
export const ICE_GATHER_TIMEOUT_MS = 2500
export const DISCONNECT_GRACE_MS = 5000

export function summarizeIceCandidate(candidate: string) {
	const parts = candidate.split(/\s+/)
	const type = candidate.match(/\styp\s+(\S+)/)?.[1] ?? null
	const protocol = parts[2]?.toLowerCase() ?? null
	const address = parts[4] ?? ''

	return {
		family: address.includes(':')
			? 'ipv6'
			: address.includes('.')
				? 'ipv4'
				: null,
		protocol,
		type,
	}
}

export function candidateTypeCounts(sdp: string) {
	const counts: Record<string, number> = {}

	for (const match of sdp.matchAll(/^a=candidate:.*\styp\s+(\S+)/gm)) {
		const type = match[1] ?? 'unknown'
		counts[type] = (counts[type] ?? 0) + 1
	}

	return counts
}

export function waitForIce(
	pc: RTCPeerConnection,
	timeoutMs: number | null = null,
	isEnough: (pc: RTCPeerConnection) => boolean = (pc) =>
		pc.iceGatheringState === 'complete',
) {
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

export function hasServerReflexiveCandidate(pc: RTCPeerConnection) {
	return candidateTypeCounts(pc.localDescription?.sdp ?? '').srflx != null
}
