import {
	type BeaconPeerId,
	type BeaconPresence,
	type ClientBeaconMessage,
	decodeServerBeaconMessage,
	type ExchangeId,
	parseBeaconPeerId,
	parseExchangeId,
} from '../../contracts/beacon'
import type {
	AnswerDescription,
	OfferDescription,
} from '../../contracts/signal'
import { bytesToBase64Url } from '../binary'
import { log } from '../log'
import { randomBase64Url } from '../random'

export type { BeaconPresence } from '../../contracts/beacon'

/** Beacon socket lifecycle state projected into invite-link UI. */
export type BeaconStatus = 'failed' | 'finding' | 'idle' | 'ready'

/** Room-discovery socket; room contents remain on authenticated WebRTC links. */
export type BeaconClient = {
	close: () => void
}

type CommonBeaconOptions = {
	discoveryId: Uint8Array
	onPresence: (presence: BeaconPresence) => void
	onStatus: (status: BeaconStatus) => void
}

type HostBeaconOptions = CommonBeaconOptions & {
	createOffer: (
		exchangeId: ExchangeId,
		to: BeaconPeerId | null,
	) => Promise<OfferDescription | null>
	onAnswer: (
		exchangeId: ExchangeId,
		from: BeaconPeerId,
		answer: AnswerDescription,
	) => void
	role: 'host'
}

type GuestBeaconOptions = CommonBeaconOptions & {
	onOffer: (
		offer: OfferDescription,
		from: BeaconPeerId,
		reply: (answer: AnswerDescription) => void,
	) => void
	role: 'guest'
}

type BeaconOptions = GuestBeaconOptions | HostBeaconOptions

const EXCHANGE_ID_BYTES = 16
const PEER_ID_BYTES = 16
const RECONNECT_MAXIMUM_MS = 60_000
const RECONNECT_MINIMUM_MS = 10_000
const RECONNECT_VARIANCE_MS = 5_000
const REFRESH_OFFER_INTERVAL_MS = 30_000

const decodeBeaconMessage = (data: unknown) => {
	if (typeof data !== 'string') return null

	try {
		const message: unknown = JSON.parse(data)
		return decodeServerBeaconMessage(message)
	} catch {
		return null
	}
}

const beaconUrl = (discoveryId: Uint8Array) => {
	const url = new URL(
		`/-/${bytesToBase64Url(discoveryId)}`,
		window.location.href,
	)
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
	return url.href
}

export const createBeaconClient = (options: BeaconOptions): BeaconClient => {
	const url = beaconUrl(options.discoveryId)
	const peerId = parseBeaconPeerId(randomBase64Url(PEER_ID_BYTES))
	if (peerId == null) throw new Error('Failed to create beacon peer id')
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
		options.onStatus(status)
	}

	const setPresence = (presence: BeaconPresence) => {
		options.onPresence(presence)
	}

	const send = (message: ClientBeaconMessage) => {
		if (socket?.readyState !== WebSocket.OPEN) return false

		try {
			socket.send(JSON.stringify(message))
			return true
		} catch (error) {
			log('warn', 'beacon', 'socket.send.failed', { error, url })
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

	const sendOffer = (to: BeaconPeerId | null) => {
		if (options.role !== 'host') return

		const exchangeId = parseExchangeId(randomBase64Url(EXCHANGE_ID_BYTES))
		if (exchangeId == null) throw new Error('Failed to create exchange id')
		void options
			.createOffer(exchangeId, to)
			.then((offer) => {
				if (closed || offer == null) return

				log('info', 'beacon', 'offer.sent', {
					to,
					role: options.role,
					url,
				})
				send({
					exchangeId,
					signal: offer,
					to,
					type: 'signal',
				})
			})
			.catch((error) => log('warn', 'beacon', 'offer.create.failed', { error }))
	}

	const scheduleReconnect = () => {
		if (closed) return
		if (reconnectTimer != null) return

		const delay =
			Math.min(
				2 ** reconnectAttempt * RECONNECT_MINIMUM_MS,
				RECONNECT_MAXIMUM_MS,
			) + Math.floor(Math.random() * RECONNECT_VARIANCE_MS)
		log('info', 'beacon', 'socket.reconnect.scheduled', { delay, url })
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
			log('warn', 'beacon', 'message.decode.failed', {
				length: typeof data === 'string' ? data.length : null,
				url,
			})
			return
		}

		switch (message.type) {
			case 'ready': {
				const presence = message.presence
				log('info', 'beacon', 'ready', {
					guests: presence.guests,
					hosts: presence.hosts,
					role: options.role,
					url,
				})
				setPresence(presence)
				setStatus('ready')
				if (options.role === 'host') {
					sendOffer(null)
					scheduleRefreshOffer()
				}
				return
			}
			case 'peer-joined': {
				if (message.peer.id === peerId) return

				const presence = message.presence
				log('info', 'beacon', 'peer.joined', {
					guests: presence.guests,
					hosts: presence.hosts,
					role: options.role,
					url,
				})
				setPresence(presence)
				if (options.role === 'host' && message.peer.role === 'guest') {
					sendOffer(message.peer.id)
				}
				return
			}
			case 'presence': {
				const presence = message.presence
				log('info', 'beacon', 'presence', {
					guests: presence.guests,
					hosts: presence.hosts,
					role: options.role,
					url,
				})
				setPresence(presence)
				return
			}
			case 'signal':
				if (message.signal.type === 'answer') {
					if (options.role !== 'host') return
					log('info', 'beacon', 'answer.received', { url })
					options.onAnswer(message.exchangeId, message.from, message.signal)
					return
				}
				if (options.role !== 'guest' || message.from === peerId) return

				log('info', 'beacon', 'offer.received', { url })
				options.onOffer(message.signal, message.from, (answer) => {
					log('info', 'beacon', 'answer.sent', { url })
					send({
						exchangeId: message.exchangeId,
						signal: answer,
						to: message.from,
						type: 'signal',
					})
				})
				return
			case 'error':
				log('warn', 'beacon', 'message.error', { reason: message.reason, url })
				setStatus('failed')
				return
		}
	}

	const openSocket = () => {
		if (closed) return

		setStatus('finding')
		let nextSocket: WebSocket
		try {
			nextSocket = new WebSocket(url)
		} catch (error) {
			log('warn', 'beacon', 'socket.create.failed', { error, url })
			setStatus('failed')
			scheduleReconnect()
			return
		}
		socket = nextSocket

		nextSocket.onopen = () => {
			if (socket !== nextSocket) return

			log('info', 'beacon', 'socket.open', { url })
			reconnectAttempt = 0
			send({
				id: peerId,
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
			log('warn', 'beacon', 'socket.error', { type: event.type, url })
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
