import type { RoomSecret } from '../rendezvous/secret'
import type {
	PeerConnectionState,
	PeerMediaState,
	PortraitActivityState,
} from '../state'
import type { ParticipantKey } from './participant'

/** Person facts plus current transport, already projected for the portrait strip. */
export type RoomPeer = {
	activity: PortraitActivityState
	id: ParticipantKey
	mediaState?: PeerMediaState | null
	mediaStream?: MediaStream | null
	connectionState: PeerConnectionState
}

/** UI verbs; host/guest ceremony stays inside the room implementation. */
export type RoomActions = {
	acceptReply: (replyText?: string) => void
	becomeGuest: () => void
	becomeHost: () => void
	claimInviteLinkAsHost: () => void
	copyInviteLink: () => void
	copyInviteCode: () => void
	copyReplyCode: () => void
	createReply: (inviteText?: string) => void
	dismissBlipIssue: () => void
	enableSelfMedia: () => void
	sendBlip: (text?: string) => void
	sendFiles: (files: File[]) => void
	setBlipText: (text: string) => void
	setInviteText: (inviteText: string) => void
	setReplyText: (replyText: string) => void
	toggleCamera: () => void
	toggleMicrophone: () => void
	toggleScreen: () => void
}

/** Host invite start can either mint a fresh room or claim an existing link secret. */
export type StartHostOptions = {
	claimed?: boolean
	resetPeers?: boolean
	secret?: RoomSecret | null
}
