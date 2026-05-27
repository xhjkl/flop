import { DurableObject } from 'cloudflare:workers'

/** Same-origin rendezvous prefix reserved for the Worker route. */
const MEET_PREFIX = '/-/'
const BEACON_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/
const MAX_MESSAGE_LENGTH = 256 * 1024

type BeaconRole = 'guest' | 'host'

type BeaconAttachment = {
	beaconPeerId: string | null
	joinedAt: number
	role: BeaconRole | null
}

type BeaconSocket = WebSocket & {
	deserializeAttachment(): Partial<BeaconAttachment> | null
	serializeAttachment(attachment: BeaconAttachment): void
}

type Env = {
	ROOMS: DurableObjectNamespace
}

type JsonBody = Record<string, unknown>

type JsonResponseInit = ResponseInit & {
	headers?: Record<string, string>
}

type SignalDescription = {
	sdp: string
	type: 'answer' | 'offer'
}

type JoinMessage = {
	beaconPeerId: string
	role: BeaconRole
	type: 'join'
}

type OfferMessage = {
	beaconPeerId?: unknown
	offer: SignalDescription
	offerId: string
	type: 'offer'
}

type AnswerMessage = {
	answer: SignalDescription
	beaconPeerId: string
	offerId: string
	type: 'answer'
}

const json = (body: JsonBody, init: JsonResponseInit = {}) =>
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

const roomNameFromRequest = (request: Request) => {
	const { pathname } = new URL(request.url)
	if (!pathname.startsWith(MEET_PREFIX)) return null

	const discoveryId = pathname.slice(MEET_PREFIX.length)
	return BEACON_ID_PATTERN.test(discoveryId) ? discoveryId : null
}

const isRendezvousRequest = (request: Request) => {
	const { pathname } = new URL(request.url)
	return pathname.startsWith(MEET_PREFIX)
}

const parseMessage = (message: unknown) => {
	if (typeof message !== 'string') return null
	if (message.length > MAX_MESSAGE_LENGTH) return null

	try {
		const value: unknown = JSON.parse(message)
		return typeof value === 'object' && value != null
			? (value as JsonBody)
			: null
	} catch {
		return null
	}
}

const isSignalDescription = (value: unknown): value is SignalDescription => {
	return (
		typeof value === 'object' &&
		value != null &&
		'type' in value &&
		(value.type === 'offer' || value.type === 'answer') &&
		'sdp' in value &&
		typeof value.sdp === 'string'
	)
}

const isPeerId = (value: unknown): value is string => {
	return typeof value === 'string' && BEACON_ID_PATTERN.test(value)
}

const isOfferId = (value: unknown): value is string => {
	return typeof value === 'string' && BEACON_ID_PATTERN.test(value)
}

const isJoinMessage = (message: JsonBody): message is JoinMessage => {
	return (
		message.type === 'join' &&
		isPeerId(message.beaconPeerId) &&
		(message.role === 'guest' || message.role === 'host')
	)
}

const isOfferMessage = (message: JsonBody): message is OfferMessage => {
	return (
		message.type === 'offer' &&
		isOfferId(message.offerId) &&
		isSignalDescription(message.offer)
	)
}

const isAnswerMessage = (message: JsonBody): message is AnswerMessage => {
	return (
		message.type === 'answer' &&
		isPeerId(message.beaconPeerId) &&
		isOfferId(message.offerId) &&
		isSignalDescription(message.answer)
	)
}

const socketPeerId = (socket: BeaconSocket) => {
	const attachment =
		socket.deserializeAttachment() as Partial<BeaconAttachment> | null
	return isPeerId(attachment?.beaconPeerId) ? attachment.beaconPeerId : null
}

const socketRole = (socket: BeaconSocket) => {
	const attachment =
		socket.deserializeAttachment() as Partial<BeaconAttachment> | null
	return attachment?.role === 'guest' || attachment?.role === 'host'
		? attachment.role
		: null
}

const sendSocket = (socket: BeaconSocket, message: JsonBody) => {
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

		const discoveryId = roomNameFromRequest(request)
		if (discoveryId == null) {
			return json({ error: 'invalid room' }, { status: 400 })
		}

		const pair = new WebSocketPair()
		const client = pair[0]
		const server = pair[1] as BeaconSocket

		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({
			beaconPeerId: null,
			joinedAt: Date.now(),
			role: null,
		})

		return new Response(null, { status: 101, webSocket: client })
	}

	webSocketMessage(socket: BeaconSocket, data: unknown) {
		const message = parseMessage(data)
		if (message == null) {
			socket.close(1003, 'invalid message')
			return
		}

		const beaconPeerId = socketPeerId(socket)
		if (beaconPeerId == null) {
			this.handleJoin(socket, message)
			return
		}

		if (isOfferMessage(message)) {
			if (socketRole(socket) !== 'host') {
				sendSocket(socket, {
					reason: 'only hosts may offer',
					type: 'error',
				})
				return
			}

			this.forwardOffer(socket, beaconPeerId, message)
			return
		}

		if (isAnswerMessage(message)) {
			if (socketRole(socket) !== 'guest') {
				sendSocket(socket, {
					reason: 'only guests may answer',
					type: 'error',
				})
				return
			}

			this.forwardAnswer(socket, beaconPeerId, message)
			return
		}

		sendSocket(socket, {
			reason: 'invalid message',
			type: 'error',
		})
	}

	handleJoin(socket: BeaconSocket, message: JsonBody) {
		if (!isJoinMessage(message)) {
			socket.close(1008, 'join required')
			return
		}

		const beaconPeerId = message.beaconPeerId
		socket.serializeAttachment({
			beaconPeerId,
			joinedAt: Date.now(),
			role: message.role,
		})

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

	webSocketClose(socket: BeaconSocket) {
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
		sender: BeaconSocket,
		beaconPeerId: string,
		message: OfferMessage,
	) {
		const payload = {
			beaconPeerId,
			offer: message.offer,
			offerId: message.offerId,
			type: 'offer',
		}

		if (isPeerId(message.beaconPeerId)) {
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
		sender: BeaconSocket,
		beaconPeerId: string,
		message: AnswerMessage,
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

	peers(except: BeaconSocket | null = null) {
		return (this.ctx.getWebSockets() as BeaconSocket[]).filter(
			(socket) => socket !== except && socketPeerId(socket) != null,
		)
	}

	presence(...except: BeaconSocket[]) {
		const excluded = new Set(except)
		const peers = (this.ctx.getWebSockets() as BeaconSocket[]).filter(
			(socket) => !excluded.has(socket) && socketPeerId(socket) != null,
		)

		return {
			guests: peers.filter((socket) => socketRole(socket) === 'guest').length,
			hosts: peers.filter((socket) => socketRole(socket) === 'host').length,
			peers: peers.length,
		}
	}

	peerById(beaconPeerId: string) {
		return (
			(this.ctx.getWebSockets() as BeaconSocket[]).find(
				(socket) => socketPeerId(socket) === beaconPeerId,
			) ?? null
		)
	}
}

/** Public Worker route that maps one discovery id to one room object. */
export default {
	fetch(request: Request, env: Env) {
		if (isRendezvousRequest(request) && roomNameFromRequest(request) == null) {
			return json({ error: 'invalid room' }, { status: 400 })
		}

		const discoveryId = roomNameFromRequest(request)
		if (discoveryId != null) {
			if (request.headers.get('upgrade') !== 'websocket') {
				return websocketResponse()
			}

			const id = env.ROOMS.idFromName(discoveryId)
			return env.ROOMS.get(id).fetch(request)
		}

		return json({ error: 'not found' }, { status: 404 })
	},
}
