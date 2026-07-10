import { log } from './log'
import type { AnswerDescription, OfferDescription } from './signal'
import {
	acceptRoomDataChannel,
	bindChannel,
	ROOM_DATA_CHANNEL_LABEL,
} from './webrtc/channel'
import { connectionHealth } from './webrtc/connection'
import {
	DEFAULT_ICE_SERVERS,
	DISCONNECT_GRACE_MS,
	hasServerReflexiveOrRelayCandidate,
	ICE_GATHER_TIMEOUT_MS,
	RELAY_ICE_GATHER_TIMEOUT_MS,
	waitForIce,
} from './webrtc/ice'

// The room wants one simple peer: one text lane, optional camera/mic.
export type Peer = {
	createOffer: () => Promise<OfferDescription>
	acceptAnswer: (answer: AnswerDescription) => Promise<void>
	createAnswer: (offer: OfferDescription) => Promise<AnswerDescription>
	close: () => void
	relayStats: () => Promise<PeerRelayStats | null>
	trySend: (text: string) => boolean
	setLocalMedia: (stream: MediaStream | null) => void
	waitForBufferBelow: (bytes: number) => Promise<void>
}

type MediaKind = 'audio' | 'video'

// Raw browser state is useful for logs; the room renders a smaller story.
type PeerOptions = {
	onOpen?: () => void
	onClose?: () => void
	onMessage?: (text: string) => void
	onRemoteMedia?: (stream: MediaStream | null) => void
	onState?: (state: PeerStateSnapshot) => void
	iceServers?: RTCIceServer[]
	iceTransportPolicy?: RTCIceTransportPolicy
}

export type PeerRelayStats = {
	bytes: number
}

type PeerStateSnapshot = {
	connectionState: RTCPeerConnectionState
	iceConnectionState: RTCIceConnectionState
	iceGatheringState: RTCIceGatheringState
	signalingState: RTCSignalingState
}

// We only publish one local track per kind. That keeps renegotiation out of the room.
const localTrack = (stream: MediaStream | null, kind: MediaKind) => {
	const tracks =
		kind === 'audio' ? stream?.getAudioTracks() : stream?.getVideoTracks()

	return tracks?.[0] ?? null
}

const completeLocalDescription = async (pc: RTCPeerConnection) => {
	// Manual signaling has no trickle path; wait only until one viable address exists.
	await waitForIce(
		pc,
		pc.getConfiguration().iceTransportPolicy === 'relay'
			? RELAY_ICE_GATHER_TIMEOUT_MS
			: ICE_GATHER_TIMEOUT_MS,
		hasServerReflexiveOrRelayCandidate,
	)

	const description = pc.localDescription
	if (description == null) throw new Error('Missing local description')
	return description
}

export const createPeer = (options: PeerOptions = {}): Peer => {
	// The wrapper collapses three browser surfaces into one room primitive:
	// SDP for setup, data channel for packets, transceivers for optional media.
	const configuration: RTCConfiguration = {
		iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS,
	}
	if (options.iceTransportPolicy != null) {
		configuration.iceTransportPolicy = options.iceTransportPolicy
	}
	const pc = new RTCPeerConnection(configuration)
	// Tracks can arrive one by one; the UI wants one stream to hang on a card.
	const remoteTracks = new Map<string, MediaStreamTrack>()
	// A peer has one data lane. Everything room-shaped rides as packets on it.
	let channel: RTCDataChannel | null = null
	// WebRTC reports endings from several doors. The room should hear one goodbye.
	let closeEmitted = false
	// Short network blips are normal. Give them a chance to heal.
	let disconnectTimeout: ReturnType<typeof setTimeout> | null = null
	// Keep the latest self media here so new senders can catch up.
	let localMedia: MediaStream | null = null
	// Late replaceTrack calls lose if a newer camera state already exists.
	let localMediaVersion = 0
	// State logs should mark changes, not spam every browser callback.
	let stateKey = ''
	// Browsers handle per-sender swaps best when we serialize them.
	const replaceTrackQueues: Record<MediaKind, Promise<void>> = {
		audio: Promise.resolve(),
		video: Promise.resolve(),
	}
	const clearDisconnectTimeout = (recovered = true) => {
		if (disconnectTimeout == null) return

		clearTimeout(disconnectTimeout)
		disconnectTimeout = null
		if (recovered) log('warn', 'rtc', 'disconnect.grace.recovered')
	}

	const closeTransport = () => {
		// Close both surfaces; either one may have been the first to notice.
		clearDisconnectTimeout(false)
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

		// "Disconnected" is a warning, not a verdict, especially on phones.
		log('warn', 'rtc', 'disconnect.grace.start', {
			connectionState: pc.connectionState,
			iceConnectionState: pc.iceConnectionState,
			timeoutMs: DISCONNECT_GRACE_MS,
		})
		disconnectTimeout = setTimeout(() => {
			disconnectTimeout = null
			const connectionState = pc.connectionState
			const iceState = pc.iceConnectionState
			const health = connectionHealth(connectionState, iceState)
			if (health === 'disconnected' || health === 'failed') {
				log('warn', 'rtc', 'disconnect.grace.expired', {
					connectionState,
					iceConnectionState: iceState,
				})
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
		// Fatal transport state wins when the browser surfaces momentarily disagree.
		emitState()
		switch (connectionHealth(pc.connectionState, pc.iceConnectionState)) {
			case 'connected':
				clearDisconnectTimeout()
				break
			case 'failed':
				emitClose()
				break
			case 'disconnected':
				scheduleDisconnectClose()
				break
			case 'waiting':
				break
		}
	}

	const attachChannel = (nextChannel: RTCDataChannel) => {
		// Offerers create the lane; answerers receive it. After this, both look the same.
		if (!acceptRoomDataChannel(channel, nextChannel)) {
			log('warn', 'rtc', 'datachannel.rejected', {
				duplicate: channel != null,
				expectedLabel: ROOM_DATA_CHANNEL_LABEL,
				label: nextChannel.label,
			})
			return
		}

		channel = nextChannel
		bindChannel(
			nextChannel,
			{
				onMessage: options.onMessage ?? null,
				onOpen: options.onOpen ?? null,
			},
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
		// A negotiated mid means this sender is already in the SDP the other side saw.
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
		// Null tracks mean "stay connected, but stop sending this kind."
		replaceSenderTrack(
			'audio',
			currentSender('audio'),
			localTrack(localMedia, 'audio'),
			version,
		)
		replaceSenderTrack(
			'video',
			currentSender('video'),
			localTrack(localMedia, 'video'),
			version,
		)
	}

	const prepareMediaSlots = () => {
		// Reserve audio/video before offer/answer so media can turn on later.
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
		// Muted tracks still count; the remote card should be ready when they wake.
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
		// Whoever offers also names the data lane.
		attachChannel(pc.createDataChannel(ROOM_DATA_CHANNEL_LABEL))
		prepareMediaSlots()
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		const description = await completeLocalDescription(pc)
		if (description.type !== 'offer') throw new Error('Missing local offer')
		return { sdp: description.sdp, type: 'offer' as const }
	}

	const acceptAnswer = async (answer: AnswerDescription) => {
		// This completes the offerer's half of a copy-paste or beacon handshake.
		await pc.setRemoteDescription(answer)
	}

	const createAnswer = async (offer: OfferDescription) => {
		// Answerers inherit the offer's media shape, then attach their own tracks.
		await pc.setRemoteDescription(offer)
		prepareMediaSlots()

		const answer = await pc.createAnswer()
		await pc.setLocalDescription(answer)
		const description = await completeLocalDescription(pc)
		if (description.type !== 'answer') throw new Error('Missing local answer')
		return { sdp: description.sdp, type: 'answer' as const }
	}

	const close = () => {
		// Manual close is final; don't echo it back as a surprise event.
		closeEmitted = true
		closeTransport()
	}

	const trySend = (text: string) => {
		// Enqueue failure stays a normal result when the data lane closes mid-send.
		if (channel?.readyState !== 'open') return false

		try {
			channel.send(text)
			return true
		} catch {
			return false
		}
	}

	const relayStats = async (): Promise<PeerRelayStats | null> => {
		const stats = await pc.getStats()
		const stat = (id: unknown) => {
			return typeof id === 'string'
				? ((stats.get(id) as Record<string, unknown> | undefined) ?? null)
				: null
		}
		const isRelayCandidate = (id: unknown) => {
			const candidate = stat(id)
			return candidate?.candidateType === 'relay'
		}
		let selectedPair: Record<string, unknown> | null = null

		for (const report of stats.values()) {
			const item = report as Record<string, unknown>
			if (
				item.type === 'transport' &&
				typeof item.selectedCandidatePairId === 'string'
			) {
				selectedPair = stat(item.selectedCandidatePairId)
				break
			}
			if (item.type === 'candidate-pair' && item.selected === true) {
				selectedPair = item
			}
		}

		if (selectedPair == null) return null
		if (
			!isRelayCandidate(selectedPair.localCandidateId) &&
			!isRelayCandidate(selectedPair.remoteCandidateId)
		) {
			return null
		}

		const bytesSent =
			typeof selectedPair.bytesSent === 'number' ? selectedPair.bytesSent : 0
		const bytesReceived =
			typeof selectedPair.bytesReceived === 'number'
				? selectedPair.bytesReceived
				: 0
		return { bytes: bytesSent + bytesReceived }
	}

	const setLocalMedia = (stream: MediaStream | null) => {
		// Media is room state; this peer just mirrors the latest version.
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

		// Keep each kind ordered. A stale queued swap should quietly step aside.
		replaceTrackQueues[kind] = replaceTrackQueues[kind]
			.catch(() => {})
			.then(async () => {
				if (version !== localMediaVersion) {
					return
				}

				await sender.replaceTrack(track)
			})
			.catch((error: unknown) => {
				log('warn', 'rtc', 'replaceTrack.failed', {
					error,
					kind,
				})
			})
	}

	const waitForBufferBelow = (bytes: number) => {
		// Large file sends need a breathing point or the channel becomes a memory queue.
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
		relayStats,
		trySend,
		setLocalMedia,
		waitForBufferBelow,
	}
}
