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

type ParticipantRoomLink = RoomLink & {
	remoteId: ParticipantId
}

/** Rendezvous lanes are setup doors, not long-term mesh links. */
const isRendezvousLink = (link: RoomLink) => {
	return link.role === 'host-rendezvous' || link.role === 'guest-rendezvous'
}

/** Link that has crossed the room identity boundary. */
export const isParticipantLink = (
	link: RoomLink,
): link is ParticipantRoomLink => {
	return link.remoteId != null
}

/** Rendezvous link still waiting for a room participant identity. */
const isUnadmittedRendezvousLink = (link: RoomLink) => {
	return isRendezvousLink(link) && !isParticipantLink(link)
}

/** Invite-link candidate created through beacon discovery. */
export const isBeaconLink = (link: RoomLink) => {
	return link.source === 'beacon'
}

/** Copy-paste candidate created from manual invite/reply codes. */
const isManualLink = (link: RoomLink) => {
	return link.source === 'manual'
}

/** Link that passed either manual possession or beacon secret proof. */
export const isVerifiedLink = (link: RoomLink) => {
	return link.auth === 'verified'
}

/** Host-side rendezvous doorway, before or after admission. */
export const isHostRendezvousLink = (link: RoomLink) => {
	return link.role === 'host-rendezvous'
}

/** Guest-side rendezvous doorway, before or after admission. */
export const isGuestRendezvousLink = (link: RoomLink) => {
	return link.role === 'guest-rendezvous'
}

/** Anonymous beacon transport still competing to become a participant link. */
export const isBeaconCandidate = (link: RoomLink, role?: LinkRole) => {
	return (
		isBeaconLink(link) &&
		!isParticipantLink(link) &&
		(role == null || link.role === role)
	)
}

/** Manual host offer waiting for the guest's admitted hello. */
export const isManualHostInviteLink = (link: RoomLink) => {
	return (
		isManualLink(link) && isHostRendezvousLink(link) && !isParticipantLink(link)
	)
}

/** Manual guest answer waiting for host admission. */
export const isManualGuestReplyLink = (link: RoomLink) => {
	return (
		isManualLink(link) &&
		isGuestRendezvousLink(link) &&
		!isParticipantLink(link)
	)
}

/** Open invite/reply lane with no admitted participant yet. */
export const findRendezvousLink = (
	links: Iterable<RoomLink>,
	role?: LinkRole,
	source?: LinkSource,
) => {
	for (const link of links) {
		if (!isUnadmittedRendezvousLink(link)) continue
		if (role != null && link.role !== role) continue
		if (source != null && link.source !== source) continue
		return link
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
		if (isParticipantLink(link) && participantKey(link.remoteId) === key) {
			return link
		}
	}

	return null
}

/** Live links that crossed the hello/welcome identity boundary. */
export const liveIdentifiedLinks = (links: Iterable<RoomLink>) => {
	// Broadcasts only go to links that made it past the hello/welcome line.
	return [...links].filter((link) => link.live && isParticipantLink(link))
}
