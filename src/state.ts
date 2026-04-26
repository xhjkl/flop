export type PeerState = 'live' | 'waiting'

export type PeerMediaState = {
	cameraEnabled: boolean
	microphoneEnabled: boolean
}

export type HostConnectionStatus =
	| 'accepting-reply'
	| 'creating-invite'
	| 'invite-ready'

export type AutoInviteStatus = 'failed' | 'finding' | 'idle'

export type GuestConnectionStatus =
	| 'connected'
	| 'creating-reply'
	| 'finding-link'
	| 'needs-invite'
	| 'reply-ready'

export type HostConnectionState = {
	side: 'host'
	status: HostConnectionStatus
	autoInviteLink: string
	autoStatus: AutoInviteStatus
	manualInviteLink: string
	replyText: string
	issue: string | null
}

export type GuestConnectionState = {
	side: 'guest'
	status: GuestConnectionStatus
	inviteText: string
	replyCode: string
	issue: string | null
}

export type ClosedConnectionState = {
	side: 'closed'
	issue: string | null
}

export type ConnectionState =
	| ClosedConnectionState
	| GuestConnectionState
	| HostConnectionState

export type PortraitFileState = {
	id: string
	name: string
	progress: number
	state: 'sending' | 'receiving' | 'ready' | 'error'
	url: string | null
}

export type PortraitActivityState = {
	blip: string | null
	files: PortraitFileState[]
}

export type BlipComposerState = {
	issue: string | null
	text: string
}
