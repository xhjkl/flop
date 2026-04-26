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
	participantId: ParticipantId
	state: PeerState
}

export function emptyParticipantActivity(): PortraitActivityState {
	return { blip: null, files: [] }
}

export function participantKey(id: ParticipantId): ParticipantKey {
	return participantIdToString(id)
}

export function mergeParticipant(
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
		participantId: participant.id,
		state: existing?.state ?? 'waiting',
	}
}

export function rosterParticipant(participant: RoomParticipant): Participant {
	return {
		id: participant.participantId,
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
