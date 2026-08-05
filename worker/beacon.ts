import { DurableObject } from 'cloudflare:workers'
import {
	type BeaconPeerId,
	type BeaconRole,
	type ClientBeaconMessage,
	decodeClientBeaconMessage,
	isBeaconId,
	parseBeaconPeerId,
	type ServerBeaconMessage,
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

/** Rendezvous route, retaining invalid room ids for a precise 400 response. */
export const rendezvousRoute = (request: Request) => {
	const { pathname } = new URL(request.url)
	if (!pathname.startsWith(RENDEZVOUS_PREFIX)) return null

	const discoveryId = pathname.slice(RENDEZVOUS_PREFIX.length)
	return { discoveryId: isBeaconId(discoveryId) ? discoveryId : null }
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

		const discoveryId = rendezvousRoute(request)?.discoveryId ?? null
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

	private handleJoin(
		socket: WebSocket,
		message: Extract<ClientBeaconMessage, { type: 'join' }>,
	) {
		const peerId = message.id
		if (this.peers().some((peer) => socketPeerId(peer) === peerId)) {
			sendSocket(socket, { reason: 'peer id already joined', type: 'error' })
			socket.close(1008, 'peer id already joined')
			return
		}
		if (
			message.role === 'host' &&
			this.peers().some((peer) => socketRole(peer) === 'host')
		) {
			sendSocket(socket, { reason: 'host already joined', type: 'error' })
			socket.close(1008, 'host already joined')
			return
		}

		socket.serializeAttachment({
			peerId,
			role: message.role,
		} satisfies BeaconAttachment)
		this.broadcastPeers()
	}

	webSocketClose(socket: WebSocket) {
		this.broadcastPeers(socket)
	}

	private forwardSignal(
		sender: WebSocket,
		peerId: BeaconPeerId,
		message: Extract<ClientBeaconMessage, { type: 'signal' }>,
	) {
		const payload: Extract<ServerBeaconMessage, { type: 'signal' }> = {
			exchangeId: message.exchangeId,
			from: peerId,
			signal: message.signal,
			type: 'signal',
		}

		const target = this.peers().find(
			(socket) => socketPeerId(socket) === message.to,
		)
		const expectedRole = message.signal.type === 'offer' ? 'guest' : 'host'
		if (
			target != null &&
			target !== sender &&
			socketRole(target) === expectedRole
		) {
			sendSocket(target, payload)
		}
	}

	/** Publish the complete discovery membership after each join or leave. */
	private broadcastPeers(excluding: WebSocket | null = null) {
		const sockets = this.peers(excluding)
		const peers = sockets.flatMap((socket) => {
			const id = socketPeerId(socket)
			const role = socketRole(socket)
			return id == null || role == null ? [] : [{ id, role }]
		})
		for (const socket of sockets) sendSocket(socket, { peers, type: 'peers' })
	}

	private peers(except: WebSocket | null = null) {
		return this.ctx
			.getWebSockets()
			.filter((socket) => socket !== except && socketPeerId(socket) != null)
	}
}
