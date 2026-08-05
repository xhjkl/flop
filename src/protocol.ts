import {
	isSignalDescription,
	parseSignalExchangeId,
	type SignalDescription,
	type SignalExchangeId,
} from '../contracts/signal'
import { randomHex } from './random'

/** Room-scoped participant identity whose lexical order assigns mesh dialing. */
export type ParticipantId = string & {
	readonly ParticipantId: unique symbol
}

/** Host-owned room membership in stable presentation order. */
export type Roster = ParticipantId[]

/** Local participant identity and the host anchoring its room membership. */
export type RoomMembership = {
	readonly hostId: ParticipantId
	readonly selfId: ParticipantId
}

/** Camera, microphone, and screen state a participant publishes to peers. */
export type MediaPresence = {
	cameraEnabled: boolean
	microphoneEnabled: boolean
	screenEnabled: boolean
}

/** Room packets: host-owned membership plus peer-owned activity and mesh signaling. */
export type Packet =
	| { type: 'hello' }
	| { nonce: string; type: 'auth-challenge' }
	| { mac: string; type: 'auth-accepted' }
	| { mac: string; nonce: string; type: 'auth-response' }
	| { text: string; type: 'blip' }
	| (MediaPresence & { type: 'media-state' })
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
	| (RoomMembership & { roster: Roster; type: 'welcome' })
	| { type: 'roster'; roster: Roster }
	| {
			exchangeId: SignalExchangeId
			type: 'peer-signal'
			from: ParticipantId
			signal: SignalDescription
			to: ParticipantId
	  }

/** Validate a participant id crossing a protocol or test boundary. */
export const parseParticipantId = (value: string): ParticipantId | null => {
	if (!/^[0-9a-f]{16}$/.test(value)) return null
	return value as ParticipantId
}

/** New room-scoped participant identity. */
export const newParticipantId = (): ParticipantId => {
	return randomHex(8) as ParticipantId
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value != null
}

const decodeParticipantId = (value: unknown) => {
	return typeof value === 'string' ? parseParticipantId(value) : null
}

const decodeRoster = (value: unknown): Roster | null => {
	if (!Array.isArray(value)) return null

	const roster: Roster = []
	const seen = new Set<ParticipantId>()
	for (const valueParticipantId of value) {
		const participantId = decodeParticipantId(valueParticipantId)
		if (participantId == null || seen.has(participantId)) return null

		seen.add(participantId)
		roster.push(participantId)
	}

	return roster
}

const isFileSize = (value: unknown): value is number => {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Packet encoder for the room data-channel protocol. */
export const encodePacket = (message: Packet) => {
	return JSON.stringify(message)
}

/** Packet decoder that rejects malformed or unknown room messages. */
export const decodePacket = (text: string): Packet | null => {
	let value: unknown

	try {
		value = JSON.parse(text)
	} catch {
		return null
	}

	if (!isRecord(value)) return null
	const message = value

	// Every field crossing a data channel is untrusted, including discriminants.
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
			return hostId == null ||
				selfId == null ||
				hostId === selfId ||
				roster == null ||
				!roster.includes(hostId) ||
				!roster.includes(selfId)
				? null
				: { hostId, roster, selfId, type: 'welcome' }
		}
		case 'roster': {
			const roster = decodeRoster(message.roster)
			return roster == null ? null : { roster, type: 'roster' }
		}
		case 'peer-signal': {
			const exchangeId = parseSignalExchangeId(message.exchangeId)
			const from = decodeParticipantId(message.from)
			const to = decodeParticipantId(message.to)
			return exchangeId == null ||
				from == null ||
				to == null ||
				!isSignalDescription(message.signal)
				? null
				: {
						exchangeId,
						from,
						signal: message.signal,
						to,
						type: 'peer-signal',
					}
		}
		default:
			return null
	}
}
