import {
	type AnswerDescription,
	isAnswerDescription,
	isOfferDescription,
	type OfferDescription,
} from './signal'

/** Side a rendezvous socket serves before WebRTC admission. */
export type BeaconRole = 'guest' | 'host'

/** Room presence summary with no room identity or content. */
export type BeaconPresence = {
	guests: number
	hosts: number
	peers: number
}

export type ClientBeaconMessage =
	| { beaconPeerId: string; role: BeaconRole; type: 'join' }
	| {
			beaconPeerId: string | null
			offer: OfferDescription
			offerId: string
			type: 'offer'
	  }
	| {
			answer: AnswerDescription
			beaconPeerId: string
			offerId: string
			type: 'answer'
	  }

type PresenceFields = BeaconPresence & {
	type: 'presence'
	leftPeerId: string | null
	leftRole: BeaconRole | null
}

export type ServerBeaconMessage =
	| (BeaconPresence & { beaconPeerId: string; type: 'ready' })
	| (BeaconPresence & {
			beaconPeerId: string
			role: BeaconRole
			type: 'peer-joined'
	  })
	| PresenceFields
	| {
			beaconPeerId: string
			offer: OfferDescription
			offerId: string
			type: 'offer'
	  }
	| {
			answer: AnswerDescription
			beaconPeerId: string
			offerId: string
			type: 'answer'
	  }
	| { reason: string; type: 'error' }

export type ClientBeaconJoinMessage = Extract<
	ClientBeaconMessage,
	{ type: 'join' }
>
export type ClientBeaconOfferMessage = Extract<
	ClientBeaconMessage,
	{ type: 'offer' }
>
export type ClientBeaconAnswerMessage = Extract<
	ClientBeaconMessage,
	{ type: 'answer' }
>
export type ServerBeaconOfferMessage = Extract<
	ServerBeaconMessage,
	{ type: 'offer' }
>
export type ServerBeaconAnswerMessage = Extract<
	ServerBeaconMessage,
	{ type: 'answer' }
>

const BEACON_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export const isBeaconId = (value: unknown): value is string => {
	return typeof value === 'string' && BEACON_ID_PATTERN.test(value)
}

const record = (value: unknown): Record<string, unknown> | null => {
	if (typeof value !== 'object' || value == null) return null
	return value as Record<string, unknown>
}

const role = (value: unknown): BeaconRole | null => {
	return value === 'guest' || value === 'host' ? value : null
}

const count = (value: unknown) => {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: null
}

const presence = (message: Record<string, unknown>): BeaconPresence | null => {
	const guests = count(message.guests)
	const hosts = count(message.hosts)
	const peers = count(message.peers)
	return guests == null || hosts == null || peers == null
		? null
		: { guests, hosts, peers }
}

/** Client message accepted by the rendezvous Worker. */
export const decodeClientBeaconMessage = (
	value: unknown,
): ClientBeaconMessage | null => {
	const message = record(value)
	if (message == null) return null

	switch (message.type) {
		case 'join': {
			const messageRole = role(message.role)
			return !isBeaconId(message.beaconPeerId) || messageRole == null
				? null
				: {
						beaconPeerId: message.beaconPeerId,
						role: messageRole,
						type: 'join',
					}
		}
		case 'offer':
			return (message.beaconPeerId !== null &&
				!isBeaconId(message.beaconPeerId)) ||
				!isBeaconId(message.offerId) ||
				!isOfferDescription(message.offer)
				? null
				: {
						beaconPeerId: message.beaconPeerId,
						offer: message.offer,
						offerId: message.offerId,
						type: 'offer',
					}
		case 'answer':
			return !isBeaconId(message.beaconPeerId) ||
				!isBeaconId(message.offerId) ||
				!isAnswerDescription(message.answer)
				? null
				: {
						answer: message.answer,
						beaconPeerId: message.beaconPeerId,
						offerId: message.offerId,
						type: 'answer',
					}
		default:
			return null
	}
}

/** Server message accepted by a rendezvous client. */
export const decodeServerBeaconMessage = (
	value: unknown,
): ServerBeaconMessage | null => {
	const message = record(value)
	if (message == null) return null

	switch (message.type) {
		case 'ready': {
			const messagePresence = presence(message)
			return !isBeaconId(message.beaconPeerId) || messagePresence == null
				? null
				: {
						beaconPeerId: message.beaconPeerId,
						...messagePresence,
						type: 'ready',
					}
		}
		case 'peer-joined': {
			const messagePresence = presence(message)
			const messageRole = role(message.role)
			return !isBeaconId(message.beaconPeerId) ||
				messagePresence == null ||
				messageRole == null
				? null
				: {
						beaconPeerId: message.beaconPeerId,
						...messagePresence,
						role: messageRole,
						type: 'peer-joined',
					}
		}
		case 'presence': {
			const messagePresence = presence(message)
			if (
				messagePresence == null ||
				(message.leftPeerId !== null && !isBeaconId(message.leftPeerId))
			) {
				return null
			}

			const leftRole = message.leftRole === null ? null : role(message.leftRole)
			if (leftRole == null && message.leftRole !== null) return null

			return {
				...messagePresence,
				leftPeerId: message.leftPeerId,
				leftRole,
				type: 'presence',
			}
		}
		case 'offer':
			return !isBeaconId(message.beaconPeerId) ||
				!isBeaconId(message.offerId) ||
				!isOfferDescription(message.offer)
				? null
				: {
						beaconPeerId: message.beaconPeerId,
						offer: message.offer,
						offerId: message.offerId,
						type: 'offer',
					}
		case 'answer':
			return !isBeaconId(message.beaconPeerId) ||
				!isBeaconId(message.offerId) ||
				!isAnswerDescription(message.answer)
				? null
				: {
						answer: message.answer,
						beaconPeerId: message.beaconPeerId,
						offerId: message.offerId,
						type: 'answer',
					}
		case 'error':
			return typeof message.reason === 'string'
				? { reason: message.reason, type: 'error' }
				: null
		default:
			return null
	}
}
