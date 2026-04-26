import type { ParticipantId } from '../protocol'
import type { PeerMediaState } from '../state'
import type { Peer } from '../webrtc'
import { type ParticipantKey, participantKey } from './participant'

export type LinkId = string

export type LinkRole = 'guest-rendezvous' | 'host-rendezvous' | 'mesh'

export type RoomLink = {
	id: LinkId
	live: boolean
	mediaState: PeerMediaState | null
	mediaStream: MediaStream | null
	peer: Peer
	remoteId: ParticipantId | null
	role: LinkRole
}

export const isRendezvousLink = (link: RoomLink) => {
	return link.role === 'host-rendezvous' || link.role === 'guest-rendezvous'
}

export const findRendezvousLink = (
	links: Iterable<RoomLink>,
	role?: LinkRole,
) => {
	for (const link of links) {
		if (!isRendezvousLink(link)) continue
		if (role != null && link.role !== role) continue
		if (link.remoteId == null) return link
	}

	return null
}

export const findParticipantLink = (
	links: Iterable<RoomLink>,
	key: ParticipantKey,
) => {
	for (const link of links) {
		if (link.remoteId != null && participantKey(link.remoteId) === key) {
			return link
		}
	}

	return null
}

export const liveIdentifiedLinks = (links: Iterable<RoomLink>) => {
	return [...links].filter((link) => link.live && link.remoteId != null)
}
