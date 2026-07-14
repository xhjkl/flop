import { emptySelfMedia, type SelfMedia } from '../self-media'
import type { BlipComposerState } from './activity/blip'
import type {
	ClosedEntryState,
	GuestJoinState,
	HostInviteState,
	RoomEntryState,
} from './entry/state'
import type { RelayMetering } from './relay'

/** Solid room store: visible card state, not persisted room data. */
export type RoomState = {
	blipComposer: BlipComposerState
	entry: RoomEntryState
	/** Shared TURN usage shown while a room is relayed. */
	relayMetering: RelayMetering | null
	selfMedia: SelfMedia
	themeSeed: string
}

/** Host card before an invite link/code has finished preparing. */
export const emptyHostInvite = (): HostInviteState => ({
	side: 'host',
	status: 'creating-invite',
	inviteLink: '',
	inviteLinkStatus: 'idle',
	inviteCode: '',
	replyText: '',
	issue: null,
})

/** Guest card before the user has supplied any invite. */
export const emptyGuestJoin = (): GuestJoinState => ({
	side: 'guest',
	status: 'needs-invite',
	inviteText: '',
	inviteLinkPresence: null,
	relayFallbackSecondsLeft: null,
	replyCode: '',
	issue: null,
})

/** Closed room recovery card. */
export const closedEntry = (): ClosedEntryState => ({
	side: 'closed',
	issue: null,
})

/** Empty local blip composer. */
export const emptyBlipComposer = (): BlipComposerState => ({
	issue: null,
	text: '',
})

/** Initial room store seeded by the first local host identity. */
export const emptyRoomState = (themeSeed: string): RoomState => {
	return {
		blipComposer: emptyBlipComposer(),
		entry: emptyHostInvite(),
		relayMetering: null,
		selfMedia: emptySelfMedia(),
		themeSeed,
	}
}
