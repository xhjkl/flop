import type { ParticipantId } from '../protocol'
import type { PeerMediaState } from '../state'
import type { Peer } from '../webrtc'
import { type ParticipantKey, participantKey } from './participant'

/** Stable transport id minted before a remote participant is known. */
export type LinkId = string

/** Room role a WebRTC transport currently serves. */
export type LinkRole = 'guest-rendezvous' | 'host-rendezvous' | 'mesh'
/** Discovery path that created the transport. */
export type LinkSource = 'beacon' | 'manual'
/** Beacon secret proof state; manual links are trusted by copy-paste possession. */
export type LinkAuthState = 'pending' | 'verified'

/** Transport that may later become a participant once the room knows who is there. */
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
	beaconPeerId: string | null
}

/** Rendezvous lanes are setup doors, not long-term mesh links. */
export const isRendezvousLink = (link: RoomLink) => {
	return link.role === 'host-rendezvous' || link.role === 'guest-rendezvous'
}

/** Open invite/reply lane with no admitted participant yet. */
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

/** Participant link lookup across rendezvous-promoted and mesh links. */
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

/** Live links that crossed the hello/welcome identity boundary. */
export const liveIdentifiedLinks = (links: Iterable<RoomLink>) => {
	// Broadcasts only go to links that made it past the hello/welcome line.
	return [...links].filter((link) => link.live && link.remoteId != null)
}
