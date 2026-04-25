import { decodeSignal, encodeSignal } from './signal'

export type Peer = {
	createOffer: () => Promise<string>
	acceptAnswer: (encoded: string) => Promise<void>
	createAnswer: (encodedOffer: string) => Promise<string>
	close: () => void
	send: (text: string) => boolean
	setLocalMedia: (stream: MediaStream | null) => void
	waitForBufferBelow: (bytes: number) => Promise<void>
}

type PeerOptions = {
	debugLabel?: string
	onOpen?: () => void
	onClose?: () => void
	onMessage?: (text: string) => void
	onRemoteMedia?: (stream: MediaStream | null) => void
	iceServers?: RTCIceServer[]
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
	{ urls: 'stun:stun.l.google.com:19302' },
	{ urls: 'stun:stun.cloudflare.com:3478' },
]

// STUN helps peers find each other; it is not a relay and should not become a server path.
const ICE_GATHER_TIMEOUT_MS = 10000
const DISCONNECT_GRACE_MS = 5000

function debugValue(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return {
			message: value.message,
			name: value.name,
		}
	}

	return value
}

function rtcDebug(event: string, details: Record<string, unknown> = {}) {
	console.debug('[flop:rtc]', JSON.stringify({ event, ...details }, debugValue))
}

type RtcDebug = typeof rtcDebug

function summarizeIceCandidate(candidate: string) {
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

function candidateTypeCounts(sdp: string) {
	const counts: Record<string, number> = {}

	for (const match of sdp.matchAll(/^a=candidate:.*\styp\s+(\S+)/gm)) {
		const type = match[1] ?? 'unknown'
		counts[type] = (counts[type] ?? 0) + 1
	}

	return counts
}

function waitForIce(pc: RTCPeerConnection, timeoutMs: number | null = null) {
	if (pc.iceGatheringState === 'complete') return Promise.resolve()

	return new Promise<void>((resolve) => {
		let timeoutId: ReturnType<typeof setTimeout> | null = null

		const cleanup = () => {
			pc.removeEventListener('icegatheringstatechange', handleChange)
			pc.removeEventListener('signalingstatechange', handleSignalChange)
			if (timeoutId != null) clearTimeout(timeoutId)
		}

		const handleChange = () => {
			if (pc.iceGatheringState !== 'complete') return
			cleanup()
			resolve()
		}

		const handleSignalChange = () => {
			if (pc.signalingState !== 'closed') return
			cleanup()
			resolve()
		}

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

function bindChannel(
	channel: RTCDataChannel,
	options: PeerOptions,
	onClose: () => void,
	debug: RtcDebug,
) {
	channel.onopen = () => {
		debug('datachannel.open', {
			bufferedAmount: channel.bufferedAmount,
			channel: channel.label,
		})
		options.onOpen?.()
	}
	channel.onclose = () => {
		debug('datachannel.close', { channel: channel.label })
		onClose()
	}
	channel.onerror = (event) => {
		debug('datachannel.error', { channel: channel.label, type: event.type })
	}
	channel.onmessage = (event) => {
		if (typeof event.data !== 'string') return

		debug('datachannel.message', {
			channel: channel.label,
			length: event.data.length,
		})
		options.onMessage?.(event.data)
	}
}

async function encodeLocalDescription(pc: RTCPeerConnection, debug: RtcDebug) {
	// Manual signaling has no trickle path, so wait for useful candidates before making a code.
	await waitForIce(pc, ICE_GATHER_TIMEOUT_MS)

	const description = pc.localDescription
	if (description == null) throw new Error('Missing local description')

	debug('local-description', {
		candidateTypes: candidateTypeCounts(description.sdp ?? ''),
		iceGatheringState: pc.iceGatheringState,
		signalingState: pc.signalingState,
		type: description.type,
	})

	return encodeSignal(description)
}

function firstTrack(stream: MediaStream | null, kind: 'audio' | 'video') {
	return kind === 'audio'
		? (stream?.getAudioTracks()[0] ?? null)
		: (stream?.getVideoTracks()[0] ?? null)
}

function statString(stat: Record<string, unknown>, key: string) {
	const value = stat[key]
	return typeof value === 'string' ? value : null
}

function statNumber(stat: Record<string, unknown>, key: string) {
	const value = stat[key]
	return typeof value === 'number' ? value : null
}

export function createPeer(options: PeerOptions = {}): Peer {
	const pc = new RTCPeerConnection({
		iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS,
	})
	// Stable sendrecv slots let camera/mic start later without a second invite ceremony.
	const audioSender = pc.addTransceiver('audio', {
		direction: 'sendrecv',
	}).sender
	const videoSender = pc.addTransceiver('video', {
		direction: 'sendrecv',
	}).sender
	let remoteStream: MediaStream | null = null
	let channel: RTCDataChannel | null = null
	let closeEmitted = false
	let disconnectTimeout: ReturnType<typeof setTimeout> | null = null
	const debugPeer = options.debugLabel ?? 'peer'

	const debug: RtcDebug = (event, details = {}) => {
		rtcDebug(event, { peer: debugPeer, ...details })
	}

	debug('peer.create', {
		iceServers: (options.iceServers ?? DEFAULT_ICE_SERVERS).flatMap((server) =>
			typeof server.urls === 'string' ? [server.urls] : server.urls,
		),
	})

	async function logSelectedCandidatePair(reason: string) {
		try {
			const report = await pc.getStats()
			const stats = [...report.values()] as Array<Record<string, unknown>>
			const candidates = new Map<string, Record<string, unknown>>()
			let selectedPair: Record<string, unknown> | null = null

			for (const stat of stats) {
				if (
					stat.type === 'local-candidate' ||
					stat.type === 'remote-candidate'
				) {
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

	function clearDisconnectTimeout() {
		if (disconnectTimeout == null) return

		clearTimeout(disconnectTimeout)
		disconnectTimeout = null
	}

	function closeTransport() {
		clearDisconnectTimeout()
		debug('peer.close', {
			connectionState: pc.connectionState,
			iceConnectionState: pc.iceConnectionState,
			signalingState: pc.signalingState,
		})
		try {
			channel?.close()
		} catch {}

		pc.close()
	}

	function emitClose() {
		if (closeEmitted) return

		closeEmitted = true
		closeTransport()
		options.onClose?.()
	}

	function scheduleDisconnectClose() {
		if (disconnectTimeout != null) return

		disconnectTimeout = setTimeout(() => {
			const connectionState = pc.connectionState
			const iceState = pc.iceConnectionState
			if (
				connectionState === 'disconnected' ||
				connectionState === 'failed' ||
				iceState === 'disconnected' ||
				iceState === 'failed'
			) {
				emitClose()
			}
		}, DISCONNECT_GRACE_MS)
	}

	function handleConnectionHealth() {
		const connectionState = pc.connectionState
		const iceState = pc.iceConnectionState
		debug('connection.state', {
			connectionState,
			iceConnectionState: iceState,
			iceGatheringState: pc.iceGatheringState,
			signalingState: pc.signalingState,
		})

		if (connectionState === 'connected' || iceState === 'connected') {
			clearDisconnectTimeout()
			void logSelectedCandidatePair('connected')
			return
		}

		if (
			connectionState === 'failed' ||
			connectionState === 'closed' ||
			iceState === 'failed' ||
			iceState === 'closed'
		) {
			void logSelectedCandidatePair('closed-or-failed')
			emitClose()
			return
		}

		if (connectionState === 'disconnected' || iceState === 'disconnected') {
			void logSelectedCandidatePair('disconnected')
			scheduleDisconnectClose()
		}
	}

	function attachChannel(nextChannel: RTCDataChannel) {
		channel = nextChannel
		bindChannel(nextChannel, options, emitClose, debug)
	}

	pc.addEventListener('connectionstatechange', handleConnectionHealth)
	pc.addEventListener('iceconnectionstatechange', handleConnectionHealth)
	pc.addEventListener('icecandidate', (event) => {
		debug(
			event.candidate == null ? 'icecandidate.complete' : 'icecandidate',
			event.candidate == null
				? { iceGatheringState: pc.iceGatheringState }
				: summarizeIceCandidate(event.candidate.candidate),
		)
	})
	pc.addEventListener('icecandidateerror', (event) => {
		debug('icecandidate.error', {
			errorCode: event.errorCode,
			errorText: event.errorText,
			url: event.url,
		})
	})

	pc.ontrack = (event) => {
		remoteStream = event.streams[0] ?? remoteStream ?? new MediaStream()
		debug('track.remote', {
			id: event.track.id,
			kind: event.track.kind,
			muted: event.track.muted,
			readyState: event.track.readyState,
			streamIds: event.streams.map((stream) => stream.id),
		})

		if (!remoteStream.getTracks().includes(event.track)) {
			remoteStream.addTrack(event.track)
		}

		options.onRemoteMedia?.(remoteStream)
		event.track.addEventListener('mute', () => {
			debug('track.remote.mute', {
				id: event.track.id,
				kind: event.track.kind,
			})
		})
		event.track.addEventListener('unmute', () => {
			debug('track.remote.unmute', {
				id: event.track.id,
				kind: event.track.kind,
			})
		})
		event.track.addEventListener('ended', () => {
			debug('track.remote.ended', {
				id: event.track.id,
				kind: event.track.kind,
			})
			options.onRemoteMedia?.(remoteStream)
		})
	}

	pc.ondatachannel = (event) => {
		attachChannel(event.channel)
	}

	async function createOffer() {
		debug('offer.create')
		attachChannel(pc.createDataChannel('data'))
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		return encodeLocalDescription(pc, debug)
	}

	async function acceptAnswer(encoded: string) {
		debug('answer.accept')
		const answer = await decodeSignal<RTCSessionDescriptionInit>(encoded)
		await pc.setRemoteDescription(answer)
	}

	async function createAnswer(encodedOffer: string) {
		debug('answer.create')
		const offer = await decodeSignal<RTCSessionDescriptionInit>(encodedOffer)
		await pc.setRemoteDescription(offer)

		const answer = await pc.createAnswer()
		await pc.setLocalDescription(answer)
		return encodeLocalDescription(pc, debug)
	}

	function close() {
		closeEmitted = true
		closeTransport()
	}

	function send(text: string) {
		if (channel?.readyState !== 'open') return false

		try {
			channel.send(text)
			return true
		} catch {
			return false
		}
	}

	function setLocalMedia(stream: MediaStream | null) {
		replaceSenderTrack('audio', audioSender, firstTrack(stream, 'audio'))
		replaceSenderTrack('video', videoSender, firstTrack(stream, 'video'))
	}

	function replaceSenderTrack(
		kind: 'audio' | 'video',
		sender: RTCRtpSender,
		track: MediaStreamTrack | null,
	) {
		debug('replaceTrack.start', {
			enabled: track?.enabled ?? null,
			id: track?.id ?? null,
			kind,
			readyState: track?.readyState ?? null,
		})

		void sender
			.replaceTrack(track)
			.then(() => {
				debug('replaceTrack.done', {
					id: track?.id ?? null,
					kind,
				})
			})
			.catch((error: unknown) => {
				debug('replaceTrack.failed', {
					error,
					id: track?.id ?? null,
					kind,
				})
			})
	}

	function waitForBufferBelow(bytes: number) {
		const activeChannel = channel
		if (
			activeChannel == null ||
			activeChannel.readyState !== 'open' ||
			activeChannel.bufferedAmount <= bytes
		) {
			return Promise.resolve()
		}

		// Enough backpressure to keep file sending smooth without turning this into a transport library.
		return new Promise<void>((resolve) => {
			let timeoutId: ReturnType<typeof setTimeout> | null = null

			const cleanup = () => {
				activeChannel.removeEventListener('bufferedamountlow', done)
				activeChannel.removeEventListener('close', done)
				if (timeoutId != null) clearTimeout(timeoutId)
			}

			const done = () => {
				cleanup()
				resolve()
			}

			activeChannel.bufferedAmountLowThreshold = bytes
			activeChannel.addEventListener('bufferedamountlow', done)
			activeChannel.addEventListener('close', done)
			timeoutId = setTimeout(done, 1000)
		})
	}

	return {
		createOffer,
		acceptAnswer,
		createAnswer,
		close,
		send,
		setLocalMedia,
		waitForBufferBelow,
	}
}
