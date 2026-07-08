import {
	type Participant,
	type ParticipantId,
	participantIdToString,
} from '../protocol'
import { randomBytes } from '../random'
import type { PortraitActivityState } from '../state'

/** Solid store path key for a protocol participant id. */
export type ParticipantKey = string

/** Roster identity plus the activity this browser has observed for that person. */
export type RoomParticipant = {
	activity: PortraitActivityState
	id: ParticipantKey
	participantId: ParticipantId
}

/** New participant activity before any social packets arrive. */
export const emptyParticipantActivity = (): PortraitActivityState => {
	// New people arrive quiet; the portrait grows as packets land.
	return { blip: null, files: [] }
}

/** Store-safe participant key. */
export const participantKey = (id: ParticipantId): ParticipantKey => {
	// BigInt is good protocol state, but store paths need plain strings.
	return participantIdToString(id)
}

/** Roster refresh merge that preserves locally observed activity. */
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

/** Protocol roster entry stripped of local activity. */
export const rosterParticipant = (
	participant: RoomParticipant,
): Participant => {
	// Rosters are identity only. Activity stays local and social.
	return {
		id: participant.participantId,
	}
}

/** Temporary room participant id. */
export const randomParticipantId = (): ParticipantId => {
	// Eight random bytes is plenty for a room-sized temporary identity.
	const bytes = randomBytes(8)
	let id = 0n

	for (const byte of bytes) {
		id = (id << 8n) | BigInt(byte)
	}

	return id
}
