import {
	type Participant,
	type ParticipantId,
	participantIdToString,
} from '../protocol'
import type { PeerState, PortraitActivityState } from '../state'

// Solid store paths want strings; the protocol keeps bigint at the edge.
export type ParticipantKey = string

export type RoomParticipant = {
	activity: PortraitActivityState
	id: ParticipantKey
	mediaStream: MediaStream | null
	mediaVersion: number
	name: string
	participantId: ParticipantId
	role: Participant['role']
	state: PeerState
}

export function emptyParticipantActivity(): PortraitActivityState {
	return { blip: null, files: [] }
}

export function participantKey(id: ParticipantId): ParticipantKey {
	return participantIdToString(id)
}

export function createParticipant(
	participant: Participant,
	existing?: RoomParticipant,
): RoomParticipant {
	const id = participantKey(participant.id)
	return {
		// Roster refreshes should not erase what a person just said or sent.
		activity: existing?.activity ?? emptyParticipantActivity(),
		id,
		mediaStream: existing?.mediaStream ?? null,
		mediaVersion: existing?.mediaVersion ?? 0,
		name: participant.name,
		participantId: participant.id,
		role: participant.role,
		state: existing?.state ?? 'waiting',
	}
}

export function publicParticipant(participant: RoomParticipant): Participant {
	return {
		id: participant.participantId,
		name: participant.name,
		role: participant.role,
	}
}

export function randomParticipantId(): ParticipantId {
	const bytes = new Uint8Array(8)
	crypto.getRandomValues(bytes)
	let id = 0n

	for (const byte of bytes) {
		id = (id << 8n) | BigInt(byte)
	}

	return id
}
