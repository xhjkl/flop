import { DurableObject } from 'cloudflare:workers'
import {
	type BeaconRole,
	type ClientBeaconAnswerMessage,
	type ClientBeaconJoinMessage,
	type ClientBeaconOfferMessage,
	decodeClientBeaconMessage,
	isBeaconId,
	type ServerBeaconMessage,
	type ServerBeaconOfferMessage,
} from '../contracts/beacon'
import { json } from './common'

/** Same-origin rendezvous prefix reserved for room discovery sockets. */
const RENDEZVOUS_PREFIX = '/-/'
const MAX_MESSAGE_LENGTH = 256 * 1024

type BeaconAttachment = {
	beaconPeerId: string | null
	role: BeaconRole | null
}

export const websocketResponse = () =>
	new Response('Expected a WebSocket upgrade', {
		status: 426,
		headers: { upgrade: 'websocket' },
	})

/** Valid room discovery id carried by a rendezvous URL. */
export const discoveryIdFromRequest = (request: Request) => {
	const { pathname } = new URL(request.url)
	if (!pathname.startsWith(RENDEZVOUS_PREFIX)) return null

	const discoveryId = pathname.slice(RENDEZVOUS_PREFIX.length)
	return isBeaconId(discoveryId) ? discoveryId : null
}

export const isRendezvousRequest = (request: Request) => {
	const { pathname } = new URL(request.url)
	return pathname.startsWith(RENDEZVOUS_PREFIX)
}

const parseMessage = (message: unknown) => {
	if (typeof message !== 'string') return null
	if (message.length > MAX_MESSAGE_LENGTH) return null

	try {
		const value: unknown = JSON.parse(message)
		return decodeClientBeaconMessage(value)
	} catch {
		return null
	}
}

const attachment = (socket: WebSocket) => {
	const attachment = socket.deserializeAttachment()
	return typeof attachment === 'object' && attachment != null
		? attachment
		: null
}

const socketPeerId = (socket: WebSocket) => {
	const value = attachment(socket)
	return value != null &&
		'beaconPeerId' in value &&
		isBeaconId(value.beaconPeerId)
		? value.beaconPeerId
		: null
}

const socketRole = (socket: WebSocket) => {
	const value = attachment(socket)
	return value != null &&
		'role' in value &&
		(value.role === 'guest' || value.role === 'host')
		? value.role
		: null
}

const sendSocket = (socket: WebSocket, message: ServerBeaconMessage) => {
	try {
		socket.send(JSON.stringify(message))
		return true
	} catch {
		return false
	}
}

/** Room-scoped WebSocket fanout for WebRTC signaling only. */
export class FlopRoom extends DurableObject {
	fetch(request: Request) {
		if (request.headers.get('upgrade') !== 'websocket') {
			return websocketResponse()
		}

		const discoveryId = discoveryIdFromRequest(request)
		if (discoveryId == null) {
			return json({ error: 'invalid room' }, { status: 400 })
		}

		const pair = new WebSocketPair()
		const client = pair[0]
		const server = pair[1]

		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({
			beaconPeerId: null,
			role: null,
		} satisfies BeaconAttachment)

		return new Response(null, { status: 101, webSocket: client })
	}

	webSocketMessage(socket: WebSocket, data: unknown) {
		const message = parseMessage(data)
		if (message == null) {
			socket.close(1003, 'invalid message')
			return
		}

		const beaconPeerId = socketPeerId(socket)
		if (beaconPeerId == null) {
			if (message.type !== 'join') {
				socket.close(1008, 'join required')
				return
			}

			this.handleJoin(socket, message)
			return
		}

		switch (message.type) {
			case 'offer':
				if (socketRole(socket) !== 'host') {
					sendSocket(socket, {
						reason: 'only hosts may offer',
						type: 'error',
					})
					return
				}

				this.forwardOffer(socket, beaconPeerId, message)
				return
			case 'answer':
				if (socketRole(socket) !== 'guest') {
					sendSocket(socket, {
						reason: 'only guests may answer',
						type: 'error',
					})
					return
				}

				this.forwardAnswer(socket, beaconPeerId, message)
				return
			case 'join':
				sendSocket(socket, {
					reason: 'invalid message',
					type: 'error',
				})
				return
		}
	}

	handleJoin(socket: WebSocket, message: ClientBeaconJoinMessage) {
		const beaconPeerId = message.beaconPeerId
		socket.serializeAttachment({
			beaconPeerId,
			role: message.role,
		} satisfies BeaconAttachment)

		sendSocket(socket, {
			beaconPeerId,
			...this.presence(socket),
			type: 'ready',
		})

		for (const peer of this.peers(socket)) {
			sendSocket(peer, {
				beaconPeerId,
				...this.presence(peer),
				role: message.role,
				type: 'peer-joined',
			})
		}
	}

	webSocketClose(socket: WebSocket) {
		const leftPeerId = socketPeerId(socket)
		const leftRole = socketRole(socket)

		for (const peer of this.peers(socket)) {
			sendSocket(peer, {
				...this.presence(peer, socket),
				leftPeerId,
				leftRole,
				type: 'presence',
			})
		}
	}

	forwardOffer(
		sender: WebSocket,
		beaconPeerId: string,
		message: ClientBeaconOfferMessage,
	) {
		const payload: ServerBeaconOfferMessage = {
			beaconPeerId,
			offer: message.offer,
			offerId: message.offerId,
			type: 'offer',
		}

		if (message.beaconPeerId != null) {
			const target = this.peerById(message.beaconPeerId)
			if (
				target != null &&
				target !== sender &&
				socketRole(target) === 'guest'
			) {
				sendSocket(target, payload)
			}
			return
		}

		for (const peer of this.peers(sender)) {
			if (socketRole(peer) !== 'guest') continue

			sendSocket(peer, payload)
		}
	}

	forwardAnswer(
		sender: WebSocket,
		beaconPeerId: string,
		message: ClientBeaconAnswerMessage,
	) {
		const target = this.peerById(message.beaconPeerId)
		if (target == null) return
		if (target === sender) return
		if (socketRole(target) !== 'host') return

		sendSocket(target, {
			answer: message.answer,
			beaconPeerId,
			offerId: message.offerId,
			type: 'answer',
		})
	}

	peers(except: WebSocket | null = null) {
		return this.ctx
			.getWebSockets()
			.filter((socket) => socket !== except && socketPeerId(socket) != null)
	}

	presence(...except: WebSocket[]) {
		const excluded = new Set(except)
		const peers = this.ctx
			.getWebSockets()
			.filter((socket) => !excluded.has(socket) && socketPeerId(socket) != null)

		return {
			guests: peers.filter((socket) => socketRole(socket) === 'guest').length,
			hosts: peers.filter((socket) => socketRole(socket) === 'host').length,
			peers: peers.length,
		}
	}

	peerById(beaconPeerId: string) {
		return (
			this.ctx
				.getWebSockets()
				.find((socket) => socketPeerId(socket) === beaconPeerId) ?? null
		)
	}
}
