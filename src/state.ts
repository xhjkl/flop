export type PeerState = 'live' | 'waiting'

export type ConnectionPhase =
	| 'creating-invite'
	| 'invite-ready'
	| 'accepting-reply'
	| 'needs-invite'
	| 'creating-reply'
	| 'reply-ready'
	| 'connected'
	| 'closed'

export type ConnectionState = {
	phase: ConnectionPhase
	inviteLink: string
	inviteText: string
	replyCode: string
	replyText: string
	issue: string | null
}

export function isHostConnection(phase: ConnectionPhase) {
	return (
		phase === 'creating-invite' ||
		phase === 'invite-ready' ||
		phase === 'accepting-reply'
	)
}

export function isGuestConnection(phase: ConnectionPhase) {
	return (
		phase === 'needs-invite' ||
		phase === 'creating-reply' ||
		phase === 'reply-ready' ||
		phase === 'connected'
	)
}

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
