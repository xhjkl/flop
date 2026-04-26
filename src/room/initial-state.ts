import { emptySelfMedia, type SelfMedia } from '../self-media'
import type {
	BlipComposerState,
	ClosedConnectionState,
	ConnectionState,
	GuestConnectionState,
	HostConnectionState,
} from '../state'

// These factories name visible card states, not persisted room data.
export type RoomState = {
	blipComposer: BlipComposerState
	connection: ConnectionState
	selfMedia: SelfMedia
	themeSeed: string
}

export const emptyHostConnection = (): HostConnectionState => ({
	side: 'host',
	status: 'creating-invite',
	inviteLink: '',
	replyText: '',
	issue: null,
})

export const emptyGuestConnection = (): GuestConnectionState => ({
	side: 'guest',
	status: 'needs-invite',
	inviteText: '',
	replyCode: '',
	issue: null,
})

export const closedConnection = (): ClosedConnectionState => ({
	side: 'closed',
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
