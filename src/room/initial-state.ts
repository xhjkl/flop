import { emptySelfMedia, type SelfMedia } from '../self-media'
import type { BlipComposerState, ConnectionState } from '../state'

// These factories name visible card states, not persisted room data.
export type RoomState = {
	blipComposer: BlipComposerState
	connection: ConnectionState
	selfMedia: SelfMedia
	themeSeed: string
}

export const emptyHostConnection = (): ConnectionState => ({
	phase: 'creating-invite',
	inviteLink: '',
	inviteText: '',
	replyCode: '',
	replyText: '',
	issue: null,
})

export const emptyGuestConnection = (): ConnectionState => ({
	phase: 'needs-invite',
	inviteLink: '',
	inviteText: '',
	replyCode: '',
	replyText: '',
	issue: null,
})

export const emptyBlipComposer = (): BlipComposerState => ({
	issue: null,
	text: '',
})

export function emptyRoomState(themeSeed: string): RoomState {
	return {
		blipComposer: emptyBlipComposer(),
		connection: emptyHostConnection(),
		selfMedia: emptySelfMedia(),
		themeSeed,
	}
}
