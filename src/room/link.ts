import type { BeaconPeerId } from '../../contracts/beacon'
import type { ParticipantId } from '../protocol'
import type { RtcPeer } from '../webrtc'
import type { MediaPresence } from './activity/media'

/** Stable transport id minted before a remote participant is known. */
export type LinkId = string

/** Portrait-level transport state, intentionally smaller than WebRTC state. */
export type LinkStatus = 'live' | 'waiting'

export type AdmissionSide = 'guest' | 'host'
export type AdmissionPath = 'beacon' | 'manual'
export type BeaconAuthState = 'pending' | 'verified'

/** What a transport means at this moment in the room lifecycle. */
export type LinkPurpose =
	| {
			kind: 'admission'
			side: AdmissionSide
			via: 'manual'
	  }
	| {
			auth: BeaconAuthState
			kind: 'admission'
			peerId: BeaconPeerId | null
			side: AdmissionSide
			via: 'beacon'
	  }
	| {
			kind: 'participant'
			participantId: ParticipantId
			via: 'admission' | 'mesh'
	  }

/** Remote media facts that can arrive independently on the same transport. */
export type RemoteMedia = {
	state: MediaPresence | null
	stream: MediaStream | null
}

/** WebRTC transport whose purpose changes once admission assigns an identity. */
export type RoomLink = {
	channelOpen: boolean
	id: LinkId
	media: RemoteMedia | null
	purpose: LinkPurpose
	rtc: RtcPeer
}

type ParticipantLink = RoomLink & {
	purpose: Extract<LinkPurpose, { kind: 'participant' }>
}

type AdmissionLink = RoomLink & {
	purpose: Extract<LinkPurpose, { kind: 'admission' }>
}

type BeaconAdmissionLink = RoomLink & {
	purpose: Extract<LinkPurpose, { kind: 'admission'; via: 'beacon' }>
}

/** Link that crossed the hello/welcome identity boundary. */
export const isParticipantLink = (link: RoomLink): link is ParticipantLink => {
	return link.purpose.kind === 'participant'
}

/** Invite doorway still waiting for a room participant identity. */
export const isAdmissionLink = (link: RoomLink): link is AdmissionLink => {
	return link.purpose.kind === 'admission'
}

/** Invite-link doorway that must prove possession of the room secret. */
export const isBeaconAdmissionLink = (
	link: RoomLink,
): link is BeaconAdmissionLink => {
	return link.purpose.kind === 'admission' && link.purpose.via === 'beacon'
}

/** Beacon admission link ready for normal room packets. */
export const isVerifiedLink = (link: RoomLink) => {
	return !isBeaconAdmissionLink(link) || link.purpose.auth === 'verified'
}

/** Anonymous beacon transport still competing to become a participant link. */
export const isBeaconCandidate = (
	link: RoomLink,
	side?: AdmissionSide,
): link is BeaconAdmissionLink => {
	return (
		isBeaconAdmissionLink(link) && (side == null || link.purpose.side === side)
	)
}

/** Pending admission lookup by the domain fields that can actually coexist. */
export const findAdmissionLink = (
	links: Iterable<RoomLink>,
	query: { side?: AdmissionSide; via?: AdmissionPath } = {},
) => {
	for (const link of links) {
		if (!isAdmissionLink(link)) continue
		if (query.side != null && link.purpose.side !== query.side) continue
		if (query.via != null && link.purpose.via !== query.via) continue
		return link
	}

	return null
}

/** Participant link lookup across promoted admission and mesh transports. */
export const findParticipantLink = (
	links: Iterable<RoomLink>,
	participantId: ParticipantId,
) => {
	for (const link of links) {
		if (
			isParticipantLink(link) &&
			link.purpose.participantId === participantId
		) {
			return link
		}
	}

	return null
}

/** Open links that crossed the hello/welcome identity boundary. */
export const openParticipantLinks = (links: Iterable<RoomLink>) => {
	return [...links].filter(
		(link) => link.channelOpen && isParticipantLink(link),
	)
}
