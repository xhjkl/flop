export type ParticipantId = bigint

export type Participant = {
	id: ParticipantId
	name: string
	role: 'host' | 'guest'
}

// Tiny room protocol: the host introduces people, then peers carry their own words and bytes.
export type RoomMessage =
	| { type: 'hello' }
	| { text: string; type: 'blip' }
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
			signal: string
			to: ParticipantId
	  }
	| {
			type: 'peer-answer'
			from: ParticipantId
			signal: string
			to: ParticipantId
	  }
	| { type: 'peer-left'; id: ParticipantId }

const PARTICIPANT_ID_KEYS = new Set(['from', 'hostId', 'id', 'selfId', 'to'])

export function participantIdToString(id: ParticipantId) {
	// BigInt is nicer inside the app; fixed hex is nicer at the JSON edge.
	return id.toString(16).padStart(16, '0')
}

function parseParticipantId(value: string): ParticipantId | null {
	if (value.length < 1 || value.length > 16) return null

	try {
		return BigInt(`0x${value}`)
	} catch {
		return null
	}
}

function encodeRoomValue(_key: string, value: unknown) {
	return typeof value === 'bigint' ? participantIdToString(value) : value
}

function decodeRoomValue(key: string, value: unknown) {
	if (!PARTICIPANT_ID_KEYS.has(key) || typeof value !== 'string') return value

	return parseParticipantId(value) ?? value
}

function isParticipant(value: unknown): value is Participant {
	if (typeof value !== 'object' || value == null) return false

	const participant = value as Participant
	return (
		typeof participant.id === 'bigint' &&
		typeof participant.name === 'string' &&
		(participant.role === 'host' || participant.role === 'guest')
	)
}

function isRoster(value: unknown): value is Participant[] {
	return Array.isArray(value) && value.every(isParticipant)
}

function isFileSize(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function encodeRoomMessage(message: RoomMessage) {
	return JSON.stringify(message, encodeRoomValue)
}

export function decodeRoomMessage(text: string): RoomMessage | null {
	let value: unknown

	try {
		value = JSON.parse(text, decodeRoomValue)
	} catch {
		return null
	}

	if (typeof value !== 'object' || value == null) return null

	// Data channels are friendly, not trusted. Keep bad packets boring.
	const message = value as RoomMessage
	switch (message.type) {
		case 'hello':
			return message
		case 'blip':
			return typeof message.text === 'string' ? message : null
		case 'file-start':
			return typeof message.id === 'string' &&
				typeof message.mime === 'string' &&
				typeof message.name === 'string' &&
				isFileSize(message.size)
				? message
				: null
		case 'file-chunk':
			return typeof message.id === 'string' && typeof message.data === 'string'
				? message
				: null
		case 'file-end':
			return typeof message.id === 'string' ? message : null
		case 'welcome':
			return typeof message.hostId === 'bigint' &&
				typeof message.selfId === 'bigint' &&
				isRoster(message.roster)
				? message
				: null
		case 'roster':
			return isRoster(message.roster) ? message : null
		case 'peer-offer':
		case 'peer-answer':
			return typeof message.from === 'bigint' &&
				typeof message.to === 'bigint' &&
				typeof message.signal === 'string'
				? message
				: null
		case 'peer-left':
			return typeof message.id === 'bigint' ? message : null
		default:
			return null
	}
}
