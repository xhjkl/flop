import type { ParticipantId } from '../protocol'
import type { PeerMediaState } from '../state'
import type { Peer } from '../webrtc'
import { type ParticipantKey, participantKey } from './participant'

export type LinkId = string

export type LinkRole = 'guest-rendezvous' | 'host-rendezvous' | 'mesh'
export type LinkSource = 'manual' | 'tracker'
export type LinkAuthState = 'pending' | 'verified'

// A link starts as transport, then becomes a person once we know who is there.
export type RoomLink = {
	auth: LinkAuthState
	authNonce: string | null
	id: LinkId
	live: boolean
	mediaState: PeerMediaState | null
	mediaStream: MediaStream | null
	peer: Peer
	remoteId: ParticipantId | null
	role: LinkRole
	source: LinkSource
	trackerPeerId: string | null
}

export const isRendezvousLink = (link: RoomLink) => {
	return link.role === 'host-rendezvous' || link.role === 'guest-rendezvous'
}

// The open invite/reply lane has no person yet. That is the one the UI is waiting on.
export const findRendezvousLink = (
	links: Iterable<RoomLink>,
	role?: LinkRole,
	source?: LinkSource,
) => {
	for (const link of links) {
		if (!isRendezvousLink(link)) continue
		if (role != null && link.role !== role) continue
		if (source != null && link.source !== source) continue
		if (link.remoteId == null) return link
	}

	return null
}

export const findParticipantLink = (
	links: Iterable<RoomLink>,
	key: ParticipantKey,
) => {
	// Participant ids are protocol values; keys are how Solid stores them.
	for (const link of links) {
		if (link.remoteId != null && participantKey(link.remoteId) === key) {
			return link
		}
	}

	return null
}

export const liveIdentifiedLinks = (links: Iterable<RoomLink>) => {
	// Broadcasts only go to links that made it past the hello/welcome line.
	return [...links].filter((link) => link.live && link.remoteId != null)
}
