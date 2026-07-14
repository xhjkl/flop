import { DurableObject } from 'cloudflare:workers'
import {
	type BeaconPeerId,
	type BeaconRole,
	type ClientBeaconJoinMessage,
	type ClientBeaconSignalMessage,
	decodeClientBeaconMessage,
	isBeaconId,
	parseBeaconPeerId,
	type ServerBeaconMessage,
	type ServerBeaconSignalMessage,
} from '../contracts/beacon'
import { json } from './common'

/** Same-origin rendezvous prefix reserved for room discovery sockets. */
const RENDEZVOUS_PREFIX = '/-/'
const MAX_MESSAGE_LENGTH = 256 * 1024

type BeaconAttachment = {
	peerId: BeaconPeerId | null
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
	return value != null && 'peerId' in value
		? parseBeaconPeerId(value.peerId)
		: null
}

const socketRole = (socket: WebSocket): BeaconRole | null => {
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
export class RendezvousRoom extends DurableObject {
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
			peerId: null,
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

		const peerId = socketPeerId(socket)
		if (peerId == null) {
			if (message.type !== 'join') {
				socket.close(1008, 'join required')
				return
			}

			this.handleJoin(socket, message)
			return
		}

		switch (message.type) {
			case 'signal': {
				const expectedRole = message.signal.type === 'offer' ? 'host' : 'guest'
				if (socketRole(socket) !== expectedRole) {
					sendSocket(socket, {
						reason: `only ${expectedRole}s may send ${message.signal.type}s`,
						type: 'error',
					})
					return
				}

				this.forwardSignal(socket, peerId, message)
				return
			}
			case 'join':
				sendSocket(socket, {
					reason: 'invalid message',
					type: 'error',
				})
				return
		}
	}

	handleJoin(socket: WebSocket, message: ClientBeaconJoinMessage) {
		const peerId = message.id
		socket.serializeAttachment({
			peerId,
			role: message.role,
		} satisfies BeaconAttachment)

		sendSocket(socket, {
			presence: this.presence(socket),
			selfId: peerId,
			type: 'ready',
		})

		for (const peer of this.peers(socket)) {
			sendSocket(peer, {
				peer: { id: peerId, role: message.role },
				presence: this.presence(peer),
				type: 'peer-joined',
			})
		}
	}

	webSocketClose(socket: WebSocket) {
		const leftPeerId = socketPeerId(socket)
		const leftRole = socketRole(socket)
		const left =
			leftPeerId == null || leftRole == null
				? null
				: { id: leftPeerId, role: leftRole }

		for (const peer of this.peers(socket)) {
			sendSocket(peer, {
				left,
				presence: this.presence(peer, socket),
				type: 'presence',
			})
		}
	}

	forwardSignal(
		sender: WebSocket,
		peerId: BeaconPeerId,
		message: ClientBeaconSignalMessage,
	) {
		const payload: ServerBeaconSignalMessage = {
			exchangeId: message.exchangeId,
			from: peerId,
			signal: message.signal,
			type: 'signal',
		}

		if (message.to != null) {
			const target = this.peerById(message.to)
			const expectedRole = message.signal.type === 'offer' ? 'guest' : 'host'
			if (
				target != null &&
				target !== sender &&
				socketRole(target) === expectedRole
			) {
				sendSocket(target, payload)
			}
			return
		}

		// Only host offers may broadcast; answers always target their offerer.
		if (message.signal.type !== 'offer') return
		for (const peer of this.peers(sender)) {
			if (socketRole(peer) !== 'guest') continue

			sendSocket(peer, payload)
		}
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
		}
	}

	peerById(peerId: BeaconPeerId) {
		return (
			this.ctx
				.getWebSockets()
				.find((socket) => socketPeerId(socket) === peerId) ?? null
		)
	}
}
