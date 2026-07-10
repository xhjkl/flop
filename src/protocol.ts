import {
	type AnswerDescription,
	isAnswerDescription,
	isOfferDescription,
	type OfferDescription,
} from './signal'

/** Ephemeral room identity carried as fixed-width hex at the JSON edge. */
export type ParticipantId = bigint

/** Roster entry owned by the host and intentionally free of activity state. */
export type Participant = {
	id: ParticipantId
}

/** Tiny room protocol: the host introduces people, then peers carry their own words and bytes. */
export type Packet =
	| { type: 'hello' }
	| { nonce: string; type: 'auth-challenge' }
	| { mac: string; type: 'auth-accepted' }
	| { mac: string; nonce: string; type: 'auth-response' }
	| { text: string; type: 'blip' }
	| {
			cameraEnabled: boolean
			microphoneEnabled: boolean
			screenEnabled: boolean
			type: 'media-state'
	  }
	| {
			id: string
			mime: string
			name: string
			size: number
			type: 'file-start'
	  }
	| {
			data: string
			id: string
			type: 'file-chunk'
	  }
	| { id: string; type: 'file-end' }
	| {
			type: 'welcome'
			hostId: ParticipantId
			roster: Participant[]
			selfId: ParticipantId
	  }
	| { type: 'roster'; roster: Participant[] }
	| {
			type: 'peer-offer'
			from: ParticipantId
			signal: OfferDescription
			to: ParticipantId
	  }
	| {
			type: 'peer-answer'
			from: ParticipantId
			signal: AnswerDescription
			to: ParticipantId
	  }
	| { type: 'peer-left'; id: ParticipantId }

/** Fixed-width hex participant id used by logs, store keys, and JSON packets. */
export const participantIdToString = (id: ParticipantId) => {
	// BigInt is nicer inside the app; fixed hex is nicer at the JSON edge.
	return id.toString(16).padStart(16, '0')
}

const parseParticipantId = (value: string): ParticipantId | null => {
	if (!/^[0-9a-f]{16}$/.test(value)) return null

	try {
		return BigInt(`0x${value}`)
	} catch {
		return null
	}
}

const encodeRoomValue = (_key: string, value: unknown) => {
	return typeof value === 'bigint' ? participantIdToString(value) : value
}

const record = (value: unknown): Record<string, unknown> | null => {
	if (typeof value !== 'object' || value == null) return null
	return value as Record<string, unknown>
}

const decodeParticipantId = (value: unknown) => {
	return typeof value === 'string' ? parseParticipantId(value) : null
}

const decodeParticipant = (value: unknown): Participant | null => {
	const participant = record(value)
	if (participant == null) return null

	const id = decodeParticipantId(participant.id)
	return id == null ? null : { id }
}

const decodeRoster = (value: unknown): Participant[] | null => {
	if (!Array.isArray(value)) return null

	const roster: Participant[] = []
	for (const valueParticipant of value) {
		const participant = decodeParticipant(valueParticipant)
		if (participant == null) return null

		roster.push(participant)
	}

	return roster
}

const isFileSize = (value: unknown): value is number => {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Packet encoder for the room data-channel protocol. */
export const encodePacket = (message: Packet) => {
	return JSON.stringify(message, encodeRoomValue)
}

/** Packet decoder that rejects malformed or unknown room messages. */
export const decodePacket = (text: string): Packet | null => {
	let value: unknown

	try {
		value = JSON.parse(text) as unknown
	} catch {
		return null
	}

	const message = record(value)
	if (message == null) return null

	// Data channels are friendly, not trusted. Keep bad packets boring.
	switch (message.type) {
		case 'hello':
			return { type: 'hello' }
		case 'auth-challenge':
			return typeof message.nonce === 'string'
				? { nonce: message.nonce, type: 'auth-challenge' }
				: null
		case 'auth-accepted':
			return typeof message.mac === 'string'
				? { mac: message.mac, type: 'auth-accepted' }
				: null
		case 'auth-response':
			return typeof message.mac !== 'string' ||
				typeof message.nonce !== 'string'
				? null
				: { mac: message.mac, nonce: message.nonce, type: 'auth-response' }
		case 'blip':
			return typeof message.text === 'string'
				? { text: message.text, type: 'blip' }
				: null
		case 'media-state':
			if (
				typeof message.cameraEnabled !== 'boolean' ||
				typeof message.microphoneEnabled !== 'boolean' ||
				typeof message.screenEnabled !== 'boolean'
			) {
				return null
			}
			return {
				cameraEnabled: message.cameraEnabled,
				microphoneEnabled: message.microphoneEnabled,
				screenEnabled: message.screenEnabled,
				type: 'media-state',
			}
		case 'file-start':
			if (
				typeof message.id !== 'string' ||
				typeof message.mime !== 'string' ||
				typeof message.name !== 'string' ||
				!isFileSize(message.size)
			) {
				return null
			}
			return {
				id: message.id,
				mime: message.mime,
				name: message.name,
				size: message.size,
				type: 'file-start',
			}
		case 'file-chunk':
			return typeof message.id === 'string' && typeof message.data === 'string'
				? { data: message.data, id: message.id, type: 'file-chunk' }
				: null
		case 'file-end':
			return typeof message.id === 'string'
				? { id: message.id, type: 'file-end' }
				: null
		case 'welcome': {
			const hostId = decodeParticipantId(message.hostId)
			const selfId = decodeParticipantId(message.selfId)
			const roster = decodeRoster(message.roster)
			return hostId == null || selfId == null || roster == null
				? null
				: { hostId, roster, selfId, type: 'welcome' }
		}
		case 'roster': {
			const roster = decodeRoster(message.roster)
			return roster == null ? null : { roster, type: 'roster' }
		}
		case 'peer-offer': {
			const from = decodeParticipantId(message.from)
			const to = decodeParticipantId(message.to)
			return from == null || to == null || !isOfferDescription(message.signal)
				? null
				: { from, signal: message.signal, to, type: 'peer-offer' }
		}
		case 'peer-answer': {
			const from = decodeParticipantId(message.from)
			const to = decodeParticipantId(message.to)
			return from == null || to == null || !isAnswerDescription(message.signal)
				? null
				: { from, signal: message.signal, to, type: 'peer-answer' }
		}
		case 'peer-left': {
			const id = decodeParticipantId(message.id)
			return id == null ? null : { id, type: 'peer-left' }
		}
		default:
			return null
	}
}
