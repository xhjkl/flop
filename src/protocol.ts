export type ParticipantId = bigint

export type Participant = {
	id: ParticipantId
}

export type SignalDescription = {
	sdp: string
	type: 'answer' | 'offer'
}

// Tiny room protocol: the host introduces people, then peers carry their own words and bytes.
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
			signal: SignalDescription
			to: ParticipantId
	  }
	| {
			type: 'peer-answer'
			from: ParticipantId
			signal: SignalDescription
			to: ParticipantId
	  }
	| { type: 'peer-left'; id: ParticipantId }

const PARTICIPANT_ID_KEYS = new Set(['from', 'hostId', 'id', 'selfId', 'to'])

export const participantIdToString = (id: ParticipantId) => {
	// BigInt is nicer inside the app; fixed hex is nicer at the JSON edge.
	return id.toString(16).padStart(16, '0')
}

const parseParticipantId = (value: string): ParticipantId | null => {
	if (value.length < 1 || value.length > 16) return null

	try {
		return BigInt(`0x${value}`)
	} catch {
		return null
	}
}

const encodeRoomValue = (_key: string, value: unknown) => {
	return typeof value === 'bigint' ? participantIdToString(value) : value
}

const decodeRoomValue = (key: string, value: unknown) => {
	if (!PARTICIPANT_ID_KEYS.has(key) || typeof value !== 'string') return value

	return parseParticipantId(value) ?? value
}

const isParticipant = (value: unknown): value is Participant => {
	if (typeof value !== 'object' || value == null) return false

	const participant = value as Participant
	return typeof participant.id === 'bigint'
}

const isRoster = (value: unknown): value is Participant[] => {
	return Array.isArray(value) && value.every(isParticipant)
}

const isFileSize = (value: unknown): value is number => {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

const isSignalDescription = (value: unknown): value is SignalDescription => {
	if (typeof value !== 'object' || value == null) return false

	const signal = value as SignalDescription
	return (
		(signal.type === 'offer' || signal.type === 'answer') &&
		typeof signal.sdp === 'string'
	)
}

export const encodePacket = (message: Packet) => {
	return JSON.stringify(message, encodeRoomValue)
}

export const decodePacket = (text: string): Packet | null => {
	let value: unknown

	try {
		value = JSON.parse(text, decodeRoomValue)
	} catch {
		return null
	}

	if (typeof value !== 'object' || value == null) return null

	// Data channels are friendly, not trusted. Keep bad packets boring.
	const message = value as Packet
	switch (message.type) {
		case 'hello':
			return message
		case 'auth-challenge':
			return typeof message.nonce === 'string' ? message : null
		case 'auth-accepted':
			return typeof message.mac === 'string' ? message : null
		case 'auth-response':
			return typeof message.mac === 'string' &&
				typeof message.nonce === 'string'
				? message
				: null
		case 'blip':
			return typeof message.text === 'string' ? message : null
		case 'media-state':
			return typeof message.cameraEnabled === 'boolean' &&
				typeof message.microphoneEnabled === 'boolean' &&
				typeof message.screenEnabled === 'boolean'
				? message
				: null
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
				isSignalDescription(message.signal)
				? message
				: null
		case 'peer-left':
			return typeof message.id === 'bigint' ? message : null
		default:
			return null
	}
}
