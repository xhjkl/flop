import type { BeaconPresence, BeaconStatus } from './rendezvous/types'

/** Portrait-level transport state, intentionally smaller than WebRTC state. */
export type PeerConnectionState = 'live' | 'waiting'

/** Media presence another peer can render without knowing permission details. */
export type PeerMediaState = {
	cameraEnabled: boolean
	microphoneEnabled: boolean
	screenEnabled: boolean
}

/** Host invite card steps. */
export type HostConnectionStatus =
	| 'accepting-reply'
	| 'creating-invite'
	| 'invite-ready'

/** Invite-link discovery status shown beside the manual invite fallback. */
export type InviteLinkStatus = BeaconStatus

/** Beacon presence summary; enough to make invite-link waiting actionable. */
export type InviteLinkPresence = BeaconPresence

/** Shared TURN usage remaining for a relayed room; bytes format at the UI edge. */
export type RelayMetering = {
	bytesLeft: number
	secondsLeft: number
}

/** Guest connection card steps from paste through admission. */
export type GuestConnectionStatus =
	| 'connected'
	| 'creating-reply'
	| 'finding-link'
	| 'needs-invite'
	| 'reply-ready'

/** Host-side connection card state: one shareable invite and one pending reply. */
export type HostConnectionState = {
	side: 'host'
	status: HostConnectionStatus
	inviteLink: string
	inviteLinkStatus: InviteLinkStatus
	inviteCode: string
	replyText: string
	issue: string | null
}

/** Guest-side connection card state: consume invite, optionally produce reply. */
type GuestConnectionBase = {
	side: 'guest'
	inviteText: string
	inviteLinkPresence: InviteLinkPresence | null
	/** Direct-first relay affordance: null hides it, 0 offers the relay. */
	relayFallbackSecondsLeft: number | null
	replyCode: string
	issue: string | null
}

export type GuestConnectionState =
	| (GuestConnectionBase & { status: 'finding-link' })
	| (GuestConnectionBase & {
			status: Exclude<GuestConnectionStatus, 'finding-link'>
	  })

/** Recovery card shown after the host room is no longer reachable. */
export type ClosedConnectionState = {
	side: 'closed'
	issue: string | null
}

/** Visible connection card branch. */
export type ConnectionState =
	| ClosedConnectionState
	| GuestConnectionState
	| HostConnectionState

/** Guest invite-link branch: host discovery is live, direct transport is still pending. */
export type GuestFindingLinkConnection = GuestConnectionState & {
	status: 'finding-link'
}

export const guestFindingLinkConnection = (connection: ConnectionState) => {
	if (connection.side !== 'guest' || connection.status !== 'finding-link') {
		return null
	}

	return connection
}

/** File chip state, shared by outgoing progress and incoming downloads. */
export type PortraitFileState = {
	id: string
	name: string
	/** Bytes sent or received so far. */
	transferredBytes: number
	size: number
	state: 'sending' | 'receiving' | 'ready' | 'error'
	url: string | null
}

/** File state that should protect users from accidentally refreshing. */
export const isBusyPortraitFile = (file: PortraitFileState) => {
	return file.state === 'sending' || file.state === 'receiving'
}

/** Per-person social activity shown on the portrait card. */
export type PortraitActivityState = {
	blip: string | null
	files: PortraitFileState[]
}

/** Local composer state for blips and transfer feedback. */
export type BlipComposerState = {
	issue: string | null
	text: string
}
