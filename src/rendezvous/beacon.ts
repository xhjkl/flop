import {
	type BeaconPeer,
	type BeaconPeerId,
	type ClientBeaconMessage,
	decodeServerBeaconMessage,
	parseBeaconPeerId,
} from '../../contracts/beacon'
import type {
	AnswerDescription,
	OfferDescription,
	SignalExchangeId,
} from '../../contracts/signal'
import { bytesToBase64Url } from '../binary'
import { log } from '../log'
import { newSignalExchangeId, randomBase64Url } from '../random'

/** Beacon socket state projected into invite-link UI. */
export type BeaconSocketStatus = 'connecting' | 'failed' | 'ready'

type CommonBeaconOptions = {
	discoveryId: Uint8Array
	onPeers: (peers: BeaconPeer[]) => void
	onStatus: (status: BeaconSocketStatus) => void
}

type HostBeaconOptions = CommonBeaconOptions & {
	createOffer: (
		exchangeId: SignalExchangeId,
		to: BeaconPeerId,
	) => Promise<OfferDescription | null>
	onAnswer: (
		exchangeId: SignalExchangeId,
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

const PEER_ID_BYTES = 16
const RECONNECT_MAXIMUM_MS = 60_000
const RECONNECT_MINIMUM_MS = 10_000
const RECONNECT_VARIANCE_MS = 5_000
const OFFER_RETRY_MS = 30_000

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

/** Room-discovery socket; room contents remain on authenticated WebRTC links. */
export const createBeaconClient = (options: BeaconOptions) => {
	const url = beaconUrl(options.discoveryId)
	const peerId = parseBeaconPeerId(randomBase64Url(PEER_ID_BYTES))
	if (peerId == null) throw new Error('Failed to create beacon peer id')
	let closed = false
	let currentStatus: BeaconSocketStatus | null = null
	let guestPeers = new Set<BeaconPeerId>()
	const offerTimers = new Map<BeaconPeerId, ReturnType<typeof setTimeout>>()
	let reconnectAttempt = 0
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let socket: WebSocket | null = null

	const setStatus = (status: BeaconSocketStatus) => {
		if (status === currentStatus) return

		currentStatus = status
		options.onStatus(status)
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

	const sendOffer = async (to: BeaconPeerId) => {
		if (options.role !== 'host') return

		const exchangeId = newSignalExchangeId()
		try {
			const offer = await options.createOffer(exchangeId, to)
			if (closed || offer == null) return

			log('info', 'beacon', 'offer.sent', {
				to,
				role: options.role,
				url,
			})
			send({ exchangeId, signal: offer, to, type: 'signal' })
		} catch (error) {
			log('warn', 'beacon', 'offer.create.failed', { error })
		}
	}

	const clearOfferTimers = () => {
		for (const timer of offerTimers.values()) clearTimeout(timer)
		offerTimers.clear()
	}

	const scheduleOffer = (to: BeaconPeerId, delayMs: number) => {
		if (closed || options.role !== 'host' || offerTimers.has(to)) return

		const timer = setTimeout(() => {
			if (!guestPeers.has(to)) {
				offerTimers.delete(to)
				return
			}

			void sendOffer(to).finally(() => {
				if (offerTimers.get(to) !== timer) return
				offerTimers.delete(to)
				scheduleOffer(to, OFFER_RETRY_MS)
			})
		}, delayMs)
		offerTimers.set(to, timer)
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
			reconnectTimer = null
			if (closed) return

			reconnectAttempt++
			openSocket()
		}, delay)
		reconnectTimer = timer
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
			case 'peers': {
				const peers = message.peers.filter((peer) => peer.id !== peerId)
				log('info', 'beacon', 'peers', {
					guests: peers.filter((peer) => peer.role === 'guest').length,
					hosts: peers.filter((peer) => peer.role === 'host').length,
					role: options.role,
					url,
				})
				setStatus('ready')
				options.onPeers(peers)
				if (options.role !== 'host') return

				const nextGuests = new Set(
					peers.filter((peer) => peer.role === 'guest').map((peer) => peer.id),
				)
				for (const [id, timer] of offerTimers) {
					if (nextGuests.has(id)) continue
					clearTimeout(timer)
					offerTimers.delete(id)
				}
				guestPeers = nextGuests
				for (const id of nextGuests) scheduleOffer(id, 0)
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

		setStatus('connecting')
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
			clearOfferTimers()
			guestPeers.clear()
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
			clearOfferTimers()
			guestPeers.clear()
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

	openSocket()

	return {
		close: () => {
			closed = true
			if (reconnectTimer != null) clearTimeout(reconnectTimer)
			reconnectTimer = null
			clearOfferTimers()
			guestPeers.clear()
			socket?.close()
			socket = null
		},
	}
}
