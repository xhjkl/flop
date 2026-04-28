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
	// The host card first promises an invite, then fills link and code as they land.
	side: 'host',
	status: 'creating-invite',
	inviteLink: '',
	inviteLinkStatus: 'idle',
	inviteCode: '',
	replyText: '',
	issue: null,
})

export const emptyGuestConnection = (): GuestConnectionState => ({
	// The guest card starts with one job: paste what the host sent.
	side: 'guest',
	status: 'needs-invite',
	inviteText: '',
	replyCode: '',
	issue: null,
})

export const closedConnection = (): ClosedConnectionState => ({
	// Closed is a visible recovery state, not just missing transport.
	side: 'closed',
	issue: null,
})

export const emptyBlipComposer = (): BlipComposerState => ({
	// Text survives typing; issues are short-lived nudges.
	issue: null,
	text: '',
})

export const emptyRoomState = (themeSeed: string): RoomState => {
	// The first host identity paints the room before anyone joins.
	return {
		blipComposer: emptyBlipComposer(),
		connection: emptyHostConnection(),
		selfMedia: emptySelfMedia(),
		themeSeed,
	}
}
