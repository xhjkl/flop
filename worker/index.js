import { DurableObject } from 'cloudflare:workers'

const MEET_PREFIX = '/-/'
const DISCOVERY_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const OFFER_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const BEACON_OBJECT_NAME = 'flop'
const MAX_MESSAGE_LENGTH = 256 * 1024

const json = (body, init = {}) =>
	new Response(JSON.stringify(body), {
		...init,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			...init.headers,
		},
	})

const websocketResponse = () =>
	new Response('Expected a WebSocket upgrade', {
		status: 426,
		headers: { upgrade: 'websocket' },
	})

const roomNameFromRequest = (request) => {
	const { pathname } = new URL(request.url)
	if (!pathname.startsWith(MEET_PREFIX)) return null

	const discoveryId = pathname.slice(MEET_PREFIX.length)
	return DISCOVERY_ID_PATTERN.test(discoveryId) ? discoveryId : null
}

const isRendezvousRequest = (request) => {
	const { pathname } = new URL(request.url)
	return pathname.startsWith(MEET_PREFIX)
}

const parseMessage = (message) => {
	if (typeof message !== 'string') return null
	if (message.length > MAX_MESSAGE_LENGTH) return null

	try {
		const value = JSON.parse(message)
		return typeof value === 'object' && value != null ? value : null
	} catch {
		return null
	}
}

const isSignalDescription = (value) => {
	return (
		typeof value === 'object' &&
		value != null &&
		(value.type === 'offer' || value.type === 'answer') &&
		typeof value.sdp === 'string'
	)
}

const isPeerId = (value) => {
	return typeof value === 'string' && PEER_ID_PATTERN.test(value)
}

const isOfferId = (value) => {
	return typeof value === 'string' && OFFER_ID_PATTERN.test(value)
}

const socketAttachment = (socket) => {
	const attachment = socket.deserializeAttachment()
	return typeof attachment === 'object' && attachment != null ? attachment : {}
}

const socketDiscoveryId = (socket) => {
	const attachment = socketAttachment(socket)
	return typeof attachment.discoveryId === 'string'
		? attachment.discoveryId
		: null
}

const socketPeerId = (socket) => {
	const attachment = socketAttachment(socket)
	return typeof attachment?.beaconPeerId === 'string'
		? attachment.beaconPeerId
		: null
}

const sendSocket = (socket, message) => {
	try {
		socket.send(JSON.stringify(message))
		return true
	} catch {
		return false
	}
}

export class FlopRoom extends DurableObject {
	fetch(request) {
		if (request.headers.get('upgrade') !== 'websocket') {
			return websocketResponse()
		}

		const discoveryId = roomNameFromRequest(request)
		if (discoveryId == null) {
			return json({ error: 'invalid room' }, { status: 400 })
		}

		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)

		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({ beaconPeerId: null, discoveryId })

		return new Response(null, { status: 101, webSocket: client })
	}

	webSocketMessage(socket, data) {
		const message = parseMessage(data)
		if (message == null) {
			socket.close(1003, 'invalid message')
			return
		}

		const discoveryId = socketDiscoveryId(socket)
		if (discoveryId == null) {
			socket.close(1011, 'missing room')
			return
		}

		const beaconPeerId = socketPeerId(socket)
		if (beaconPeerId == null) {
			this.handleJoin(socket, message)
			return
		}

		if (
			message.type === 'offer' &&
			isOfferId(message.offerId) &&
			isSignalDescription(message.offer)
		) {
			this.forwardOffer(socket, discoveryId, beaconPeerId, message)
			return
		}

		if (
			message.type === 'answer' &&
			isPeerId(message.beaconPeerId) &&
			isOfferId(message.offerId) &&
			isSignalDescription(message.answer)
		) {
			this.forwardAnswer(discoveryId, beaconPeerId, message)
			return
		}

		sendSocket(socket, {
			reason: 'invalid message',
			type: 'error',
		})
	}

	handleJoin(socket, message) {
		const discoveryId = socketDiscoveryId(socket)
		if (
			discoveryId == null ||
			message.type !== 'join' ||
			!isPeerId(message.beaconPeerId) ||
			(message.role !== 'guest' && message.role !== 'host')
		) {
			socket.close(1008, 'join required')
			return
		}

		const beaconPeerId = message.beaconPeerId
		socket.serializeAttachment({ beaconPeerId, discoveryId })

		const peers = this.peers(discoveryId, socket)
		sendSocket(socket, {
			beaconPeerId,
			peers: peers.length,
			type: 'ready',
		})

		for (const peer of peers) {
			sendSocket(peer, {
				beaconPeerId,
				type: 'peer-joined',
			})
		}
	}

	forwardOffer(sender, discoveryId, beaconPeerId, message) {
		const payload = {
			beaconPeerId,
			offer: message.offer,
			offerId: message.offerId,
			type: 'offer',
		}

		if (isPeerId(message.beaconPeerId)) {
			const target = this.peerById(discoveryId, message.beaconPeerId)
			if (target != null && target !== sender) sendSocket(target, payload)
			return
		}

		for (const peer of this.peers(discoveryId, sender)) {
			sendSocket(peer, payload)
		}
	}

	forwardAnswer(discoveryId, beaconPeerId, message) {
		const target = this.peerById(discoveryId, message.beaconPeerId)
		if (target == null) return

		sendSocket(target, {
			answer: message.answer,
			beaconPeerId,
			offerId: message.offerId,
			type: 'answer',
		})
	}

	peers(discoveryId, except = null) {
		return this.ctx
			.getWebSockets()
			.filter(
				(socket) =>
					socket !== except &&
					socketDiscoveryId(socket) === discoveryId &&
					socketPeerId(socket) != null,
			)
	}

	peerById(discoveryId, beaconPeerId) {
		return (
			this.ctx
				.getWebSockets()
				.find(
					(socket) =>
						socketDiscoveryId(socket) === discoveryId &&
						socketPeerId(socket) === beaconPeerId,
				) ?? null
		)
	}
}

export default {
	fetch(request, env) {
		if (isRendezvousRequest(request) && roomNameFromRequest(request) == null) {
			return json({ error: 'invalid room' }, { status: 400 })
		}

		const discoveryId = roomNameFromRequest(request)
		if (discoveryId != null) {
			if (request.headers.get('upgrade') !== 'websocket') {
				return websocketResponse()
			}

			const id = env.ROOMS.idFromName(BEACON_OBJECT_NAME)
			return env.ROOMS.get(id).fetch(request)
		}

		return json({ error: 'not found' }, { status: 404 })
	},
}
