import { isSignalDescription, type SignalDescription } from './signal'

/** Side a rendezvous socket serves before WebRTC admission. */
export type BeaconRole = 'guest' | 'host'

/** Public socket identity scoped to one discovery room. */
export type BeaconPeerId = string & {
	readonly BeaconPeerId: unique symbol
}

/** Correlation id shared by both halves of one SDP exchange. */
export type ExchangeId = string & {
	readonly ExchangeId: unique symbol
}

/** Room presence summary with no room identity or content. */
export type BeaconPresence = {
	guests: number
	hosts: number
}

/** Beacon peer projected only where join or leave identity matters. */
export type BeaconPeer = {
	id: BeaconPeerId
	role: BeaconRole
}

export type ClientBeaconMessage =
	| { id: BeaconPeerId; role: BeaconRole; type: 'join' }
	| {
			exchangeId: ExchangeId
			signal: SignalDescription
			to: BeaconPeerId | null
			type: 'signal'
	  }

export type ServerBeaconMessage =
	| { presence: BeaconPresence; selfId: BeaconPeerId; type: 'ready' }
	| { peer: BeaconPeer; presence: BeaconPresence; type: 'peer-joined' }
	| {
			left: BeaconPeer | null
			presence: BeaconPresence
			type: 'presence'
	  }
	| {
			exchangeId: ExchangeId
			from: BeaconPeerId
			signal: SignalDescription
			type: 'signal'
	  }
	| { reason: string; type: 'error' }

export type ClientBeaconJoinMessage = Extract<
	ClientBeaconMessage,
	{ type: 'join' }
>
export type ClientBeaconSignalMessage = Extract<
	ClientBeaconMessage,
	{ type: 'signal' }
>
export type ServerBeaconSignalMessage = Extract<
	ServerBeaconMessage,
	{ type: 'signal' }
>

const BEACON_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export const isBeaconId = (value: unknown): value is string => {
	return typeof value === 'string' && BEACON_ID_PATTERN.test(value)
}

/** Validate a socket peer id crossing the beacon contract. */
export const parseBeaconPeerId = (value: unknown): BeaconPeerId | null => {
	return isBeaconId(value) ? (value as BeaconPeerId) : null
}

/** Validate an SDP exchange id crossing the beacon contract. */
export const parseExchangeId = (value: unknown): ExchangeId | null => {
	return isBeaconId(value) ? (value as ExchangeId) : null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value != null
}

const role = (value: unknown): BeaconRole | null => {
	return value === 'guest' || value === 'host' ? value : null
}

const count = (value: unknown) => {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: null
}

const presence = (value: unknown): BeaconPresence | null => {
	if (!isRecord(value)) return null

	const guests = count(value.guests)
	const hosts = count(value.hosts)
	return guests == null || hosts == null ? null : { guests, hosts }
}

const peer = (value: unknown): BeaconPeer | null => {
	if (!isRecord(value)) return null

	const id = parseBeaconPeerId(value.id)
	const peerRole = role(value.role)
	return id == null || peerRole == null ? null : { id, role: peerRole }
}

/** Client message accepted by the rendezvous Worker. */
export const decodeClientBeaconMessage = (
	value: unknown,
): ClientBeaconMessage | null => {
	if (!isRecord(value)) return null

	switch (value.type) {
		case 'join': {
			const id = parseBeaconPeerId(value.id)
			const messageRole = role(value.role)
			return id == null || messageRole == null
				? null
				: { id, role: messageRole, type: 'join' }
		}
		case 'signal': {
			const exchangeId = parseExchangeId(value.exchangeId)
			const to = value.to === null ? null : parseBeaconPeerId(value.to)
			return exchangeId == null ||
				(value.to !== null && to == null) ||
				!isSignalDescription(value.signal)
				? null
				: { exchangeId, signal: value.signal, to, type: 'signal' }
		}
		default:
			return null
	}
}

/** Server message accepted by a rendezvous client. */
export const decodeServerBeaconMessage = (
	value: unknown,
): ServerBeaconMessage | null => {
	if (!isRecord(value)) return null

	switch (value.type) {
		case 'ready': {
			const selfId = parseBeaconPeerId(value.selfId)
			const messagePresence = presence(value.presence)
			return selfId == null || messagePresence == null
				? null
				: { presence: messagePresence, selfId, type: 'ready' }
		}
		case 'peer-joined': {
			const messagePeer = peer(value.peer)
			const messagePresence = presence(value.presence)
			return messagePeer == null || messagePresence == null
				? null
				: {
						peer: messagePeer,
						presence: messagePresence,
						type: 'peer-joined',
					}
		}
		case 'presence': {
			const messagePresence = presence(value.presence)
			const left = value.left === null ? null : peer(value.left)
			return messagePresence == null || (value.left !== null && left == null)
				? null
				: { left, presence: messagePresence, type: 'presence' }
		}
		case 'signal': {
			const exchangeId = parseExchangeId(value.exchangeId)
			const from = parseBeaconPeerId(value.from)
			return exchangeId == null ||
				from == null ||
				!isSignalDescription(value.signal)
				? null
				: { exchangeId, from, signal: value.signal, type: 'signal' }
		}
		case 'error':
			return typeof value.reason === 'string'
				? { reason: value.reason, type: 'error' }
				: null
		default:
			return null
	}
}
