import type { BeaconPresence } from '../../../contracts/beacon'
import type { BeaconStatus } from '../../rendezvous/beacon'

export type HostInviteStatus =
	| 'accepting-reply'
	| 'creating-invite'
	| 'invite-ready'

export type GuestJoinStatus =
	| 'connected'
	| 'creating-reply'
	| 'finding-link'
	| 'needs-invite'
	| 'reply-ready'

/** Entry failures interpreted as copy only by the connection card. */
export type EntryIssue =
	| 'direct-connection-failed'
	| 'discovery-unreachable'
	| 'host-reply-failed'
	| 'invite-creation-failed'
	| 'invite-invalid'
	| 'relay-quota-exceeded'
	| 'relay-unavailable'
	| 'reply-still-waiting'

export type HostInviteState = {
	side: 'host'
	status: HostInviteStatus
	inviteLink: string
	inviteLinkStatus: BeaconStatus
	inviteCode: string
	replyText: string
	issue: EntryIssue | null
}

type GuestJoinBase = {
	side: 'guest'
	inviteText: string
	inviteLinkPresence: BeaconPresence | null
	/** Direct-first relay affordance: null hides it, 0 offers the relay. */
	relayFallbackSecondsLeft: number | null
	replyCode: string
	issue: EntryIssue | null
}

export type GuestJoinState =
	| (GuestJoinBase & { status: 'finding-link' })
	| (GuestJoinBase & {
			status: Exclude<GuestJoinStatus, 'finding-link'>
	  })

export type ClosedEntryState = {
	side: 'closed'
	issue: EntryIssue | null
}

export type RoomEntryState = ClosedEntryState | GuestJoinState | HostInviteState

export type GuestFindingLinkEntry = GuestJoinState & {
	status: 'finding-link'
}

/** Invite-link guest still waiting for a direct admission transport. */
export const guestFindingLinkEntry = (entry: RoomEntryState) => {
	if (entry.side !== 'guest' || entry.status !== 'finding-link') return null
	return entry
}
