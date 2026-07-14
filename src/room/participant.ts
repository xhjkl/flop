import type { ParticipantId } from '../protocol'
import { randomHex } from '../random'
import type { MediaPresence } from './activity/media'
import type { LinkStatus } from './link'

/** File chip state, shared by outgoing progress and incoming downloads. */
export type ParticipantFile = {
	id: string
	name: string
	/** Bytes sent or received so far. */
	transferredBytes: number
	size: number
	state: 'sending' | 'receiving' | 'ready' | 'error'
	url: string | null
}

/** Per-person social activity shown on the portrait card. */
export type ParticipantActivity = {
	blip: string | null
	files: ParticipantFile[]
}

/** File state that should protect users from accidentally refreshing. */
export const isBusyParticipantFile = (file: ParticipantFile) => {
	return file.state === 'sending' || file.state === 'receiving'
}

/** Room member plus the activity this browser has observed for them. */
export type ParticipantState = {
	activity: ParticipantActivity
	id: ParticipantId
}

/** Person facts plus transport state projected for the portrait strip. */
export type ParticipantView = {
	activity: ParticipantActivity
	connectionState: LinkStatus
	id: ParticipantId
	mediaState: MediaPresence | null
	mediaStream: MediaStream | null
}

/** New participant activity before any social packets arrive. */
export const emptyParticipantActivity = (): ParticipantActivity => {
	return { blip: null, files: [] }
}

/** Roster refresh merge that preserves locally observed activity. */
export const mergeParticipant = (
	id: ParticipantId,
	existing: ParticipantState | null = null,
): ParticipantState => {
	return {
		// Roster refreshes should not erase what a person just said or sent.
		activity: existing?.activity ?? emptyParticipantActivity(),
		id,
	}
}

/** Temporary room participant id. */
export const randomParticipantId = (): ParticipantId => {
	// Eight random bytes is plenty for a room-sized temporary identity.
	return randomHex(8) as ParticipantId
}
