import { emptySelfMedia, type SelfMedia } from '../self-media'
import type {
	BlipComposerState,
	ClosedConnectionState,
	ConnectionState,
	GuestConnectionState,
	HostConnectionState,
	RelayMetering,
} from '../state'

/** Solid room store: visible card state, not persisted room data. */
export type RoomState = {
	blipComposer: BlipComposerState
	connection: ConnectionState
	/** Shared TURN usage shown while a room is relayed. */
	relayMetering: RelayMetering | null
	selfMedia: SelfMedia
	themeSeed: string
}

/** Host card before an invite link/code has finished preparing. */
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

/** Guest card before the user has supplied any invite. */
export const emptyGuestConnection = (): GuestConnectionState => ({
	// The guest card starts with one job: paste what the host sent.
	side: 'guest',
	status: 'needs-invite',
	inviteText: '',
	inviteLinkPresence: null,
	relayFallbackSecondsLeft: null,
	replyCode: '',
	issue: null,
})

/** Closed room recovery card. */
export const closedConnection = (): ClosedConnectionState => ({
	// Closed is a visible recovery state, not just missing transport.
	side: 'closed',
	issue: null,
})

/** Empty local blip composer. */
export const emptyBlipComposer = (): BlipComposerState => ({
	// Text survives typing; issues are short-lived nudges.
	issue: null,
	text: '',
})

/** Initial room store seeded by the first local host identity. */
export const emptyRoomState = (themeSeed: string): RoomState => {
	// The first host identity paints the room before anyone joins.
	return {
		blipComposer: emptyBlipComposer(),
		connection: emptyHostConnection(),
		relayMetering: null,
		selfMedia: emptySelfMedia(),
		themeSeed,
	}
}
