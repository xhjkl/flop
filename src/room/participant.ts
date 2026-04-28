import {
	type Participant,
	type ParticipantId,
	participantIdToString,
} from '../protocol'
import type { PortraitActivityState } from '../state'

// Solid store paths want strings; the protocol keeps bigint at the edge.
export type ParticipantKey = string

export type RoomParticipant = {
	activity: PortraitActivityState
	id: ParticipantKey
	participantId: ParticipantId
}

export const emptyParticipantActivity = (): PortraitActivityState => {
	// New people arrive quiet; the portrait grows as packets land.
	return { blip: null, files: [] }
}

export const participantKey = (id: ParticipantId): ParticipantKey => {
	// BigInt is good protocol state, but store paths need plain strings.
	return participantIdToString(id)
}

export const mergeParticipant = (
	participant: Participant,
	existing?: RoomParticipant,
): RoomParticipant => {
	const id = participantKey(participant.id)
	return {
		// Roster refreshes should not erase what a person just said or sent.
		activity: existing?.activity ?? emptyParticipantActivity(),
		id,
		participantId: participant.id,
	}
}

export const rosterParticipant = (
	participant: RoomParticipant,
): Participant => {
	// Rosters are identity only. Activity stays local and social.
	return {
		id: participant.participantId,
	}
}

export const randomParticipantId = (): ParticipantId => {
	// Eight random bytes is plenty for a room-sized temporary identity.
	const bytes = new Uint8Array(8)
	crypto.getRandomValues(bytes)
	let id = 0n

	for (const byte of bytes) {
		id = (id << 8n) | BigInt(byte)
	}

	return id
}
