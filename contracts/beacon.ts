import {
	isSignalDescription,
	parseSignalExchangeId,
	type SignalDescription,
	type SignalExchangeId,
} from './signal'

/** Side a rendezvous socket serves before WebRTC admission. */
export type BeaconRole = 'guest' | 'host'

/** Public socket identity scoped to one discovery room. */
export type BeaconPeerId = string & {
	readonly BeaconPeerId: unique symbol
}

/** Public socket identity and role within one discovery room. */
export type BeaconPeer = {
	id: BeaconPeerId
	role: BeaconRole
}

export type ClientBeaconMessage =
	| { id: BeaconPeerId; role: BeaconRole; type: 'join' }
	| {
			exchangeId: SignalExchangeId
			signal: SignalDescription
			to: BeaconPeerId
			type: 'signal'
	  }

export type ServerBeaconMessage =
	| { peers: BeaconPeer[]; type: 'peers' }
	| {
			exchangeId: SignalExchangeId
			from: BeaconPeerId
			signal: SignalDescription
			type: 'signal'
	  }
	| { reason: string; type: 'error' }

const BEACON_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export const isBeaconId = (value: unknown): value is string => {
	return typeof value === 'string' && BEACON_ID_PATTERN.test(value)
}

/** Validate a socket peer id crossing the beacon contract. */
export const parseBeaconPeerId = (value: unknown): BeaconPeerId | null => {
	return isBeaconId(value) ? (value as BeaconPeerId) : null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value != null
}

const role = (value: unknown): BeaconRole | null => {
	return value === 'guest' || value === 'host' ? value : null
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
			const exchangeId = parseSignalExchangeId(value.exchangeId)
			const to = parseBeaconPeerId(value.to)
			return exchangeId == null ||
				to == null ||
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
		case 'peers': {
			if (!Array.isArray(value.peers)) return null
			const peers = value.peers.map(peer)
			if (peers.some((item) => item == null)) return null
			const ids = new Set(peers.map((item) => item?.id))
			return ids.size === peers.length
				? { peers: peers as BeaconPeer[], type: 'peers' }
				: null
		}
		case 'signal': {
			const exchangeId = parseSignalExchangeId(value.exchangeId)
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
