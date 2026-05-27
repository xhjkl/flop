import { bytesToBase64Url } from '../binary'
import { infoLog, warnLog } from '../log'
import { isSignalDescription, type SignalDescription } from '../signal'

export type BeaconStatus = 'failed' | 'finding' | 'idle' | 'ready'

export type BeaconPresence = {
	guests: number
	hosts: number
	peers: number
}

export type BeaconRendezvous = {
	close: () => void
}

type BeaconOptions = {
	createOffer?: (
		offerId: string,
		beaconPeerId: string | null,
	) => Promise<SignalDescription | null>
	discoveryId: Uint8Array
	onAnswer?: (
		offerId: string,
		beaconPeerId: string,
		answer: SignalDescription,
	) => void
	onOffer?: (
		offer: SignalDescription,
		beaconPeerId: string,
		reply: (answer: SignalDescription) => void,
	) => void
	onPresence?: (presence: BeaconPresence) => void
	onStatus?: (status: BeaconStatus) => void
	role: 'guest' | 'host'
}

type BeaconMessage = Record<string, unknown>

const OFFER_ID_BYTES = 16
const PEER_ID_BYTES = 16
const RECONNECT_MAXIMUM_MS = 60_000
const RECONNECT_MINIMUM_MS = 10_000
const RECONNECT_VARIANCE_MS = 5_000
const REFRESH_OFFER_INTERVAL_MS = 30_000

const warnBeacon = (event: string, details: Record<string, unknown> = {}) => {
	warnLog('beacon', event, details)
}

const infoBeacon = (event: string, details: Record<string, unknown> = {}) => {
	infoLog('beacon', event, details)
}

const randomId = (length: number) => {
	const bytes = new Uint8Array(length)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}

const decodeBeaconMessage = (data: unknown) => {
	if (typeof data !== 'string') return null

	try {
		const message = JSON.parse(data) as Record<string, unknown>
		return typeof message === 'object' && message != null ? message : null
	} catch {
		return null
	}
}

const beaconCount = (value: unknown) => {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: null
}

const beaconPresence = (message: BeaconMessage): BeaconPresence | null => {
	const guests = beaconCount(message.guests)
	const hosts = beaconCount(message.hosts)
	const peers = beaconCount(message.peers)

	return guests == null || hosts == null || peers == null
		? null
		: { guests, hosts, peers }
}

const beaconUrl = (discoveryId: Uint8Array) => {
	const url = new URL(
		`/-/${bytesToBase64Url(discoveryId)}`,
		window.location.href,
	)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	return url.href
}

export const createBeaconRendezvous = (
	options: BeaconOptions,
): BeaconRendezvous => {
	const url = beaconUrl(options.discoveryId)
	const peerId = randomId(PEER_ID_BYTES)
	const timers = new Set<ReturnType<typeof setTimeout>>()
	let closed = false
	let currentStatus: BeaconStatus | null = null
	let reconnectAttempt = 0
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let refreshOfferTimer: ReturnType<typeof setTimeout> | null = null
	let socket: WebSocket | null = null

	const setStatus = (status: BeaconStatus) => {
		if (status === currentStatus) return

		currentStatus = status
		options.onStatus?.(status)
	}

	const setPresence = (presence: BeaconPresence) => {
		options.onPresence?.(presence)
	}

	const send = (message: BeaconMessage) => {
		if (socket?.readyState !== WebSocket.OPEN) return false

		try {
			socket.send(JSON.stringify(message))
			return true
		} catch (error) {
			warnBeacon('socket.send.failed', { error, url })
			socket.close()
			return false
		}
	}

	const clearRefreshOfferTimer = () => {
		if (refreshOfferTimer == null) return

		clearTimeout(refreshOfferTimer)
		timers.delete(refreshOfferTimer)
		refreshOfferTimer = null
	}

	const scheduleRefreshOffer = () => {
		clearRefreshOfferTimer()
		const timer = setTimeout(() => {
			timers.delete(timer)
			refreshOfferTimer = null
			sendOffer(null)
			if (!closed) scheduleRefreshOffer()
		}, REFRESH_OFFER_INTERVAL_MS)
		refreshOfferTimer = timer
		timers.add(timer)
	}

	const sendOffer = (beaconPeerId: string | null) => {
		if (options.createOffer == null) return

		const offerId = randomId(OFFER_ID_BYTES)
		void options
			.createOffer(offerId, beaconPeerId)
			.then((offer) => {
				if (closed || offer == null) return

				infoBeacon('offer.sent', {
					beaconPeerId,
					role: options.role,
					url,
				})
				send({
					beaconPeerId,
					offer,
					offerId,
					type: 'offer',
				})
			})
			.catch((error) => warnBeacon('offer.create.failed', { error }))
	}

	const scheduleReconnect = () => {
		if (closed) return
		if (reconnectTimer != null) return

		const delay =
			Math.min(
				2 ** reconnectAttempt * RECONNECT_MINIMUM_MS,
				RECONNECT_MAXIMUM_MS,
			) + Math.floor(Math.random() * RECONNECT_VARIANCE_MS)
		infoBeacon('socket.reconnect.scheduled', { delay, url })
		const timer = setTimeout(() => {
			timers.delete(timer)
			reconnectTimer = null
			if (closed) return

			reconnectAttempt++
			openSocket()
		}, delay)
		reconnectTimer = timer
		timers.add(timer)
	}

	const handleMessage = (data: unknown) => {
		const message = decodeBeaconMessage(data)
		if (message == null) {
			warnBeacon('message.decode.failed', {
				length: typeof data === 'string' ? data.length : null,
				url,
			})
			return
		}

		if (message.type === 'ready' && typeof message.beaconPeerId === 'string') {
			const presence = beaconPresence(message)
			infoBeacon('ready', {
				guests: presence?.guests ?? null,
				hosts: presence?.hosts ?? null,
				role: options.role,
				url,
			})
			if (presence != null) setPresence(presence)
			setStatus('ready')
			if (options.role === 'host') {
				sendOffer(null)
				scheduleRefreshOffer()
			}
			return
		}

		if (
			message.type === 'peer-joined' &&
			typeof message.beaconPeerId === 'string'
		) {
			if (message.beaconPeerId === peerId) return

			const presence = beaconPresence(message)
			infoBeacon('peer.joined', {
				guests: presence?.guests ?? null,
				hosts: presence?.hosts ?? null,
				role: options.role,
				url,
			})
			if (presence != null) setPresence(presence)
			if (options.role === 'host') {
				sendOffer(message.beaconPeerId)
			}
			return
		}

		if (message.type === 'presence') {
			const presence = beaconPresence(message)
			if (presence == null) {
				warnBeacon('presence.invalid', { url })
				return
			}

			infoBeacon('presence', {
				guests: presence.guests,
				hosts: presence.hosts,
				role: options.role,
				url,
			})
			setPresence(presence)
			return
		}

		if (
			message.type === 'answer' &&
			typeof message.offerId === 'string' &&
			typeof message.beaconPeerId === 'string' &&
			isSignalDescription(message.answer)
		) {
			infoBeacon('answer.received', { url })
			options.onAnswer?.(message.offerId, message.beaconPeerId, message.answer)
			return
		}

		if (
			message.type === 'offer' &&
			typeof message.offerId === 'string' &&
			typeof message.beaconPeerId === 'string' &&
			isSignalDescription(message.offer)
		) {
			if (message.beaconPeerId === peerId) return

			infoBeacon('offer.received', { url })
			options.onOffer?.(message.offer, message.beaconPeerId, (answer) => {
				infoBeacon('answer.sent', { url })
				send({
					answer,
					beaconPeerId: message.beaconPeerId,
					offerId: message.offerId,
					type: 'answer',
				})
			})
			return
		}

		if (message.type === 'error' && typeof message.reason === 'string') {
			warnBeacon('message.error', { reason: message.reason, url })
			setStatus('failed')
			return
		}

		warnBeacon('message.invalid', { type: message.type, url })
	}

	const openSocket = () => {
		if (closed) return

		setStatus('finding')
		let nextSocket: WebSocket
		try {
			nextSocket = new WebSocket(url)
		} catch (error) {
			warnBeacon('socket.create.failed', { error, url })
			setStatus('failed')
			scheduleReconnect()
			return
		}
		socket = nextSocket

		nextSocket.onopen = () => {
			if (socket !== nextSocket) return

			infoBeacon('socket.open', { url })
			reconnectAttempt = 0
			send({
				beaconPeerId: peerId,
				role: options.role,
				type: 'join',
			})
		}
		nextSocket.onmessage = (event) => {
			if (socket !== nextSocket) return

			handleMessage(event.data)
		}
		nextSocket.onclose = () => {
			if (socket === nextSocket) socket = null
			clearRefreshOfferTimer()
			if (closed) return

			setStatus('failed')
			scheduleReconnect()
		}
		nextSocket.onerror = (event) => {
			warnBeacon('socket.error', { type: event.type, url })
			setStatus('failed')
			nextSocket.close()
		}
	}

	setStatus('idle')
	openSocket()

	return {
		close: () => {
			closed = true
			setStatus('idle')
			for (const timer of timers) clearTimeout(timer)
			timers.clear()
			reconnectTimer = null
			clearRefreshOfferTimer()
			socket?.close()
			socket = null
		},
	}
}
