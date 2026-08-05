/** Notice codes rendered by the connection card. */
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
	manualPhase: 'accepting-reply' | 'preparing-code' | 'waiting-for-reply'
	inviteLink: string
	inviteLinkPhase: 'failed' | 'preparing' | 'ready'
	inviteCode: string
	replyText: string
	issue: EntryIssue | null
}

type GuestJoinBase = {
	side: 'guest'
	inviteText: string
	issue: EntryIssue | null
}

export type GuestJoinState =
	| (GuestJoinBase & {
			/** Whether the latest discovery membership contains a host. */
			hostPresent: boolean | null
			/** Null before a host is reachable; zero makes relay immediately available. */
			relayFallbackSecondsLeft: number | null
			status: 'discovering-host'
	  })
	| (GuestJoinBase & { replyCode: string; status: 'reply-ready' })
	| (GuestJoinBase & {
			status: 'connected' | 'creating-reply' | 'needs-invite'
	  })

export type RoomEntryState =
	| { side: 'closed' }
	| GuestJoinState
	| HostInviteState

/** Host card while its automatic and copy-paste invitations are prepared. */
export const initialHostEntry = (): HostInviteState => ({
	side: 'host',
	manualPhase: 'preparing-code',
	inviteLink: '',
	inviteLinkPhase: 'preparing',
	inviteCode: '',
	replyText: '',
	issue: null,
})

/** Guest card before the user supplies an invitation. */
export const initialGuestEntry = (): GuestJoinState => ({
	side: 'guest',
	status: 'needs-invite',
	inviteText: '',
	issue: null,
})

/** Narrow an entry to invite-link host discovery. */
export const asHostDiscovery = (entry: RoomEntryState) => {
	if (entry.side !== 'guest' || entry.status !== 'discovering-host') return null
	return entry
}
