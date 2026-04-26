import type { RtcDebug } from './debug'

function statString(stat: Record<string, unknown>, key: string) {
	const value = stat[key]
	return typeof value === 'string' ? value : null
}

function statNumber(stat: Record<string, unknown>, key: string) {
	const value = stat[key]
	return typeof value === 'number' ? value : null
}

export async function logSelectedCandidatePair(
	pc: RTCPeerConnection,
	debug: RtcDebug,
	reason: string,
) {
	// Debug breadcrumbs only; never make room behavior depend on browser stats shape.
	try {
		const report = await pc.getStats()
		const stats = [...report.values()] as Array<Record<string, unknown>>
		const candidates = new Map<string, Record<string, unknown>>()
		let selectedPair: Record<string, unknown> | null = null

		for (const stat of stats) {
			if (stat.type === 'local-candidate' || stat.type === 'remote-candidate') {
				const id = statString(stat, 'id')
				if (id != null) candidates.set(id, stat)
			}

			if (
				stat.type === 'candidate-pair' &&
				(stat.selected === true ||
					(stat.state === 'succeeded' && stat.nominated === true))
			) {
				selectedPair = stat
			}
		}

		if (selectedPair == null) return

		const localCandidate = candidates.get(
			statString(selectedPair, 'localCandidateId') ?? '',
		)
		const remoteCandidate = candidates.get(
			statString(selectedPair, 'remoteCandidateId') ?? '',
		)

		debug('candidate-pair', {
			bytesReceived: statNumber(selectedPair, 'bytesReceived'),
			bytesSent: statNumber(selectedPair, 'bytesSent'),
			localType:
				localCandidate == null
					? null
					: statString(localCandidate, 'candidateType'),
			remoteType:
				remoteCandidate == null
					? null
					: statString(remoteCandidate, 'candidateType'),
			reason,
			state: statString(selectedPair, 'state'),
		})
	} catch (error) {
		debug('stats.failed', { error })
	}
}

export async function logMediaStats(
	pc: RTCPeerConnection,
	debug: RtcDebug,
	reason: string,
) {
	// Media stats answer the important question: did frames/bytes actually move?
	try {
		const report = await pc.getStats()
		const inbound: Array<Record<string, unknown>> = []
		const outbound: Array<Record<string, unknown>> = []

		for (const raw of report.values()) {
			const stat = raw as Record<string, unknown>
			if (stat.type !== 'inbound-rtp' && stat.type !== 'outbound-rtp') {
				continue
			}
			if (stat.isRemote === true) continue

			const sample = {
				bytesReceived: statNumber(stat, 'bytesReceived'),
				bytesSent: statNumber(stat, 'bytesSent'),
				framesDecoded: statNumber(stat, 'framesDecoded'),
				framesDropped: statNumber(stat, 'framesDropped'),
				framesEncoded: statNumber(stat, 'framesEncoded'),
				framesReceived: statNumber(stat, 'framesReceived'),
				kind: statString(stat, 'kind') ?? statString(stat, 'mediaType'),
				packetsLost: statNumber(stat, 'packetsLost'),
				packetsReceived: statNumber(stat, 'packetsReceived'),
				packetsSent: statNumber(stat, 'packetsSent'),
				trackIdentifier: statString(stat, 'trackIdentifier'),
			}

			if (stat.type === 'inbound-rtp') inbound.push(sample)
			else outbound.push(sample)
		}

		debug('media-stats', { inbound, outbound, reason })
	} catch (error) {
		debug('media-stats.failed', { error })
	}
}
