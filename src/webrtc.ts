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
const ICE_GATHER_SOFT_TIMEOUT_MS = 1500

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

function bindChannel(channel: RTCDataChannel, options: PeerOptions) {
	channel.onopen = () => options.onOpen?.()
	channel.onclose = () => options.onClose?.()
	channel.onmessage = (event) => {
		if (typeof event.data === 'string') options.onMessage?.(event.data)
	}
}

async function encodeLocalDescription(pc: RTCPeerConnection) {
	// Don't make invite generation feel hung when STUN is slow or blocked.
	await waitForIce(pc, ICE_GATHER_SOFT_TIMEOUT_MS)

	const description = pc.localDescription
	if (description == null) throw new Error('Missing local description')

	return encodeSignal(description)
}

function firstTrack(stream: MediaStream | null, kind: 'audio' | 'video') {
	return kind === 'audio'
		? (stream?.getAudioTracks()[0] ?? null)
		: (stream?.getVideoTracks()[0] ?? null)
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

	function attachChannel(nextChannel: RTCDataChannel) {
		channel = nextChannel
		bindChannel(nextChannel, options)
	}

	pc.ontrack = (event) => {
		remoteStream = event.streams[0] ?? remoteStream ?? new MediaStream()

		if (!remoteStream.getTracks().includes(event.track)) {
			remoteStream.addTrack(event.track)
		}

		options.onRemoteMedia?.(remoteStream)
		event.track.addEventListener('ended', () => {
			options.onRemoteMedia?.(remoteStream)
		})
	}

	pc.ondatachannel = (event) => {
		attachChannel(event.channel)
	}

	async function createOffer() {
		attachChannel(pc.createDataChannel('data'))
		const offer = await pc.createOffer()
		await pc.setLocalDescription(offer)
		return encodeLocalDescription(pc)
	}

	async function acceptAnswer(encoded: string) {
		const answer = await decodeSignal<RTCSessionDescriptionInit>(encoded)
		await pc.setRemoteDescription(answer)
	}

	async function createAnswer(encodedOffer: string) {
		const offer = await decodeSignal<RTCSessionDescriptionInit>(encodedOffer)
		await pc.setRemoteDescription(offer)

		const answer = await pc.createAnswer()
		await pc.setLocalDescription(answer)
		return encodeLocalDescription(pc)
	}

	function close() {
		try {
			channel?.close()
		} catch {}

		pc.close()
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
		void audioSender.replaceTrack(firstTrack(stream, 'audio')).catch(() => null)
		void videoSender.replaceTrack(firstTrack(stream, 'video')).catch(() => null)
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
