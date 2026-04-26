import { warnLog } from './log'
import type { SignalDescription } from './signal'
import { bindChannel } from './webrtc/channel'
import {
	DEFAULT_ICE_SERVERS,
	DISCONNECT_GRACE_MS,
	hasServerReflexiveCandidate,
	ICE_GATHER_TIMEOUT_MS,
	waitForIce,
} from './webrtc/ice'
import { firstTrack } from './webrtc/media'

export type Peer = {
	createOffer: () => Promise<SignalDescription>
	acceptAnswer: (answer: SignalDescription) => Promise<void>
	createAnswer: (offer: SignalDescription) => Promise<SignalDescription>
	close: () => void
	send: (text: string) => boolean
	setLocalMedia: (stream: MediaStream | null) => void
	waitForBufferBelow: (bytes: number) => Promise<void>
}

type MediaKind = 'audio' | 'video'

type PeerOptions = {
	onOpen?: () => void
	onClose?: () => void
	onMessage?: (text: string) => void
	onRemoteMedia?: (stream: MediaStream | null) => void
	onState?: (state: PeerStateSnapshot) => void
	iceServers?: RTCIceServer[]
}

type PeerStateSnapshot = {
	connectionState: RTCPeerConnectionState
	iceConnectionState: RTCIceConnectionState
	iceGatheringState: RTCIceGatheringState
	signalingState: RTCSignalingState
}

const localDescription = async (pc: RTCPeerConnection) => {
	// Manual signaling has no trickle path; one srflx candidate is enough to stop making people wait.
	await waitForIce(pc, ICE_GATHER_TIMEOUT_MS, hasServerReflexiveCandidate)

	const description = pc.localDescription
	if (description == null) throw new Error('Missing local description')
	if (description.type !== 'offer' && description.type !== 'answer') {
		throw new Error('Unsupported local description')
	}

	return { sdp: description.sdp, type: description.type }
}

export const createPeer = (options: PeerOptions = {}): Peer => {
	const pc = new RTCPeerConnection({
		iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS,
	})
	const remoteTracks = new Map<string, MediaStreamTrack>()
	let channel: RTCDataChannel | null = null
	let closeEmitted = false
	let disconnectTimeout: ReturnType<typeof setTimeout> | null = null
	let localMedia: MediaStream | null = null
	let localMediaVersion = 0
	let stateKey = ''
	const replaceTrackQueues: Record<MediaKind, Promise<void>> = {
		audio: Promise.resolve(),
		video: Promise.resolve(),
	}
	const clearDisconnectTimeout = () => {
		if (disconnectTimeout == null) return

		clearTimeout(disconnectTimeout)
		disconnectTimeout = null
	}

	const closeTransport = () => {
		clearDisconnectTimeout()
		try {
			channel?.close()
		} catch {}

		pc.close()
	}

	const emitClose = () => {
		if (closeEmitted) return

		closeEmitted = true
		closeTransport()
		options.onClose?.()
	}

	const scheduleDisconnectClose = () => {
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

	const stateSnapshot = (): PeerStateSnapshot => {
		return {
			connectionState: pc.connectionState,
			iceConnectionState: pc.iceConnectionState,
			iceGatheringState: pc.iceGatheringState,
			signalingState: pc.signalingState,
		}
	}

	const emitState = () => {
		const state = stateSnapshot()
		const nextStateKey = JSON.stringify(state)
		if (nextStateKey === stateKey) return

		stateKey = nextStateKey
		options.onState?.(state)
	}

	const handleConnectionHealth = () => {
		emitState()
		const connectionState = pc.connectionState
		const iceState = pc.iceConnectionState

		if (connectionState === 'connected' || iceState === 'connected') {
			clearDisconnectTimeout()
			return
		}

		if (
			connectionState === 'failed' ||
			connectionState === 'closed' ||
			iceState === 'failed' ||
			iceState === 'closed'
		) {
			emitClose()
			return
		}

		if (connectionState === 'disconnected' || iceState === 'disconnected') {
			scheduleDisconnectClose()
		}
	}

	const attachChannel = (nextChannel: RTCDataChannel) => {
		channel = nextChannel
		bindChannel(
			nextChannel,
			{ onOpen: options.onOpen, onMessage: options.onMessage },
			emitClose,
		)
	}

	const transceiverKind = (
		transceiver: RTCRtpTransceiver,
	): MediaKind | null => {
		const kind = transceiver.receiver.track.kind
		return kind === 'audio' || kind === 'video' ? kind : null
	}

	const negotiatedOrFirstTransceiver = (kind: MediaKind) => {
		const transceivers = pc
			.getTransceivers()
			.filter(
				(transceiver) =>
					transceiverKind(transceiver) === kind &&
					transceiver.direction !== 'stopped',
			)

		return (
			transceivers.find((transceiver) => transceiver.mid != null) ??
			transceivers[0] ??
			null
		)
	}

	const ensureSender = (kind: MediaKind) => {
		// Answerers must reuse the transceiver created by the offer. Creating our own
		// early produces orphan senders that never put RTP on the wire.
		const transceiver =
			negotiatedOrFirstTransceiver(kind) ??
			pc.addTransceiver(kind, { direction: 'sendrecv' })

		if (transceiver.direction !== 'sendrecv') {
			transceiver.direction = 'sendrecv'
		}

		return transceiver.sender
	}

	const currentSender = (kind: MediaKind) => {
		return negotiatedOrFirstTransceiver(kind)?.sender ?? null
	}

	const replaceLocalTracks = (version = localMediaVersion) => {
		replaceSenderTrack(
			'audio',
			currentSender('audio'),
			firstTrack(localMedia, 'audio'),
			version,
		)
		replaceSenderTrack(
			'video',
			currentSender('video'),
			firstTrack(localMedia, 'video'),
			version,
		)
	}

	const prepareMediaSlots = () => {
		ensureSender('audio')
		ensureSender('video')
		replaceLocalTracks()
	}

	pc.addEventListener('connectionstatechange', handleConnectionHealth)
	pc.addEventListener('iceconnectionstatechange', handleConnectionHealth)

	const emitRemoteMedia = () => {
		const tracks = [...remoteTracks.values()]
		const stream = tracks.length === 0 ? null : new MediaStream(tracks)
		options.onRemoteMedia?.(stream)
	}

	pc.ontrack = (event) => {
		if (!remoteTracks.has(event.track.id)) {
			remoteTracks.set(event.track.id, event.track)
		}
		emitRemoteMedia()

		event.track.addEventListener('unmute', () => {
			emitRemoteMedia()
		})
		event.track.addEventListener('ended', () => {
			remoteTracks.delete(event.track.id)
			emitRemoteMedia()
		})
	}

	pc.ondatachannel = (event) => {
		attachChannel(event.channel)
	}

	const createOffer = async () => {
		attachChannel(pc.createDataChannel('data'))
		prepareMediaSlots()
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		return localDescription(pc)
	}

	const acceptAnswer = async (answer: SignalDescription) => {
		await pc.setRemoteDescription(answer)
	}

	const createAnswer = async (offer: SignalDescription) => {
		await pc.setRemoteDescription(offer)
		prepareMediaSlots()

		const answer = await pc.createAnswer()
		await pc.setLocalDescription(answer)
		return localDescription(pc)
	}

	const close = () => {
		closeEmitted = true
		closeTransport()
	}

	const send = (text: string) => {
		if (channel?.readyState !== 'open') return false

		try {
			channel.send(text)
			return true
		} catch {
			return false
		}
	}

	const setLocalMedia = (stream: MediaStream | null) => {
		localMedia = stream
		const version = ++localMediaVersion
		replaceLocalTracks(version)
	}

	const replaceSenderTrack = (
		kind: MediaKind,
		sender: RTCRtpSender | null,
		track: MediaStreamTrack | null,
		version: number,
	) => {
		if (sender == null) {
			return
		}

		replaceTrackQueues[kind] = replaceTrackQueues[kind]
			.catch(() => {})
			.then(async () => {
				if (version !== localMediaVersion) {
					return
				}

				await sender.replaceTrack(track)
			})
			.catch((error: unknown) => {
				warnLog('rtc', 'replaceTrack.failed', {
					error,
					kind,
				})
			})
	}

	const waitForBufferBelow = (bytes: number) => {
		const activeChannel = channel
		if (
			activeChannel == null ||
			activeChannel.readyState !== 'open' ||
			activeChannel.bufferedAmount <= bytes
		) {
			return Promise.resolve()
		}

		return new Promise<void>((resolve) => {
			let timeoutId: ReturnType<typeof setTimeout> | null = null

			const cleanup = () => {
				activeChannel.removeEventListener('bufferedamountlow', maybeDone)
				activeChannel.removeEventListener('close', done)
				if (timeoutId != null) clearTimeout(timeoutId)
			}

			const done = () => {
				cleanup()
				resolve()
			}

			const armTimeout = () => {
				if (timeoutId != null) clearTimeout(timeoutId)
				timeoutId = setTimeout(maybeDone, 1000)
			}

			const maybeDone = () => {
				if (
					activeChannel.readyState !== 'open' ||
					activeChannel.bufferedAmount <= bytes
				) {
					done()
					return
				}

				armTimeout()
			}

			activeChannel.bufferedAmountLowThreshold = bytes
			activeChannel.addEventListener('bufferedamountlow', maybeDone)
			activeChannel.addEventListener('close', done)
			maybeDone()
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
