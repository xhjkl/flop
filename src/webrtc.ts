import { decodeSignal, encodeSignal } from './signal'
import { bindChannel } from './webrtc/channel'
import { type RtcDebug, rtcDebug } from './webrtc/debug'
import {
	candidateTypeCounts,
	DEFAULT_ICE_SERVERS,
	DISCONNECT_GRACE_MS,
	hasServerReflexiveCandidate,
	ICE_GATHER_TIMEOUT_MS,
	summarizeIceCandidate,
	waitForIce,
} from './webrtc/ice'
import {
	descriptionSummary,
	firstTrack,
	streamSummary,
	trackSummary,
	transceiverSummary,
} from './webrtc/media'
import { logMediaStats, logSelectedCandidatePair } from './webrtc/stats'

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

async function encodeLocalDescription(pc: RTCPeerConnection, debug: RtcDebug) {
	// Manual signaling has no trickle path; one srflx candidate is enough to stop making people wait.
	await waitForIce(pc, ICE_GATHER_TIMEOUT_MS, hasServerReflexiveCandidate)

	const description = pc.localDescription
	if (description == null) throw new Error('Missing local description')

	debug('local-description', {
		candidateTypes: candidateTypeCounts(description.sdp ?? ''),
		description: descriptionSummary(description),
		iceGatheringState: pc.iceGatheringState,
		signalingState: pc.signalingState,
		transceivers: transceiverSummary(pc),
		type: description.type,
	})

	return encodeSignal(description)
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
	const remoteStream = new MediaStream()
	const remoteTracks = new Map<string, MediaStreamTrack>()
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
			void logSelectedCandidatePair(pc, debug, 'connected')
			void logMediaStats(pc, debug, 'connected')
			return
		}

		if (
			connectionState === 'failed' ||
			connectionState === 'closed' ||
			iceState === 'failed' ||
			iceState === 'closed'
		) {
			void logSelectedCandidatePair(pc, debug, 'closed-or-failed')
			void logMediaStats(pc, debug, 'closed-or-failed')
			emitClose()
			return
		}

		if (connectionState === 'disconnected' || iceState === 'disconnected') {
			void logSelectedCandidatePair(pc, debug, 'disconnected')
			void logMediaStats(pc, debug, 'disconnected')
			scheduleDisconnectClose()
		}
	}

	function attachChannel(nextChannel: RTCDataChannel) {
		channel = nextChannel
		bindChannel(
			nextChannel,
			{ onOpen: options.onOpen, onMessage: options.onMessage },
			emitClose,
			debug,
		)
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

	function emitRemoteMedia() {
		const stream = remoteTracks.size === 0 ? null : remoteStream
		debug('remote-media.emit', streamSummary(stream))
		options.onRemoteMedia?.(stream)
	}

	pc.ontrack = (event) => {
		debug('track.remote', {
			id: event.track.id,
			kind: event.track.kind,
			muted: event.track.muted,
			readyState: event.track.readyState,
			streamIds: event.streams.map((stream) => stream.id),
		})

		if (!remoteTracks.has(event.track.id)) {
			remoteTracks.set(event.track.id, event.track)
			remoteStream.addTrack(event.track)
		}
		emitRemoteMedia()

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
			emitRemoteMedia()
			void logMediaStats(pc, debug, `track-unmute:${event.track.kind}`)
		})
		event.track.addEventListener('ended', () => {
			debug('track.remote.ended', {
				id: event.track.id,
				kind: event.track.kind,
			})
			remoteTracks.delete(event.track.id)
			remoteStream.removeTrack(event.track)
			emitRemoteMedia()
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
		debug('remote-description', {
			description: descriptionSummary(pc.remoteDescription ?? answer),
			transceivers: transceiverSummary(pc),
		})
	}

	async function createAnswer(encodedOffer: string) {
		debug('answer.create')
		const offer = await decodeSignal<RTCSessionDescriptionInit>(encodedOffer)
		await pc.setRemoteDescription(offer)
		debug('remote-description', {
			description: descriptionSummary(pc.remoteDescription ?? offer),
			transceivers: transceiverSummary(pc),
		})

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
			kind,
			track: trackSummary(track),
		})

		void sender
			.replaceTrack(track)
			.then(() => {
				debug('replaceTrack.done', {
					kind,
					track: trackSummary(track),
					transceivers: transceiverSummary(pc),
				})
				void logMediaStats(pc, debug, `replaceTrack:${kind}`)
			})
			.catch((error: unknown) => {
				debug('replaceTrack.failed', {
					error,
					kind,
					track: trackSummary(track),
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
