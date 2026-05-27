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
export type InviteLinkStatus = 'failed' | 'finding' | 'idle' | 'ready'

/** Beacon presence summary; enough to make invite-link waiting actionable. */
export type InviteLinkPresence = {
	guests: number
	hosts: number
	peers: number
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
export type GuestConnectionState = {
	side: 'guest'
	status: GuestConnectionStatus
	inviteText: string
	inviteLinkPresence: InviteLinkPresence | null
	replyCode: string
	issue: string | null
}

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

/** File chip state, shared by outgoing progress and incoming downloads. */
export type PortraitFileState = {
	id: string
	name: string
	receivedBytes: number
	size: number
	state: 'sending' | 'receiving' | 'ready' | 'error'
	url: string | null
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
