import { decodePacket, type ParticipantId } from '../protocol'
import type { Peer } from '../webrtc'
import type { GuestFlow } from './guest'
import type { HostFlow } from './host'
import { emptyGuestConnection } from './initial-state'
import type { RoomLifecycle } from './lifecycle'
import type { LinkId, RoomLink } from './link'
import { errorRoom, infoRoom, linkLog, sendPacket, warnRoom } from './log'
import { participantKey } from './participant'
import type { RoomRuntime } from './runtime'
import { statusCopy } from './status-copy'

/** WebRTC packet dispatch and link-close consequences. */
export type ProtocolFlow = {
	handleLinkClose: (linkId: LinkId) => void
	handleLinkMessage: (linkId: LinkId, text: string) => void
	handleLinkOpen: (linkId: LinkId) => void
}

export const createProtocolFlow = (
	room: RoomRuntime,
	lifecycle: RoomLifecycle,
	host: HostFlow,
	guest: GuestFlow,
): ProtocolFlow => {
	const removeParticipantLink = (
		participantId: ParticipantId,
		options: { peer?: Peer | null } = {},
	) => {
		// Link loss can mean "one guest left" or "the whole room ended."
		const key = participantKey(participantId)
		const link = room.participantLink(participantId)
		if (link == null) return
		if (options.peer != null && link.peer !== options.peer) return

		room.fileTransfers.abortIncomingFrom(participantId)
		room.removeLink(link)

		if (room.isSelfGuest() && participantId === room.hostParticipantId) {
			lifecycle.markRoomClosed()
			return
		}

		if (room.isSelfGuest()) {
			room.mesh.startMissingOffers()
			return
		}

		// Guests can come and go. A guest only loses the room when the host disappears.
		if (room.isSelfHost()) {
			room.setParticipantKeys((keys) => keys.filter((item) => item !== key))
			room.setParticipants(key, undefined)
			room.broadcastMembershipChange({ left: participantId })

			if (
				room.liveParticipantLinkCount() === 0 &&
				room.currentRendezvousLink('host-rendezvous', 'manual') == null
			) {
				void host.startInviteAsHost({ resetPeers: false })
			}
		}
	}

	const handleLinkOpen = (linkId: LinkId) => {
		// Open transport is not always room membership; beacon auth may still be pending.
		const link = room.links.get(linkId)
		if (link == null) return

		link.live = true
		room.touchLinks()
		infoRoom('link.open', { link: linkLog(link) })

		if (link.source === 'beacon' && link.auth !== 'verified') {
			if (link.role === 'host-rendezvous') room.beaconAuth.sendChallenge(link)
			else if (link.role !== 'guest-rendezvous') {
				errorRoom('auth.unexpected-beacon-link-role', { link: linkLog(link) })
				room.closeLink(link)
			}
			return
		}

		if (link.role === 'guest-rendezvous') {
			// Guests say hello first; hosts answer with welcome and identity.
			sendPacket(link.peer, { type: 'hello' })
			return
		}

		if (link.remoteId != null) {
			// Reconnected or mesh links should receive the current self presence.
			room.blips.sendLocalToPeer(link.peer)
			room.sendLocalMediaStateToPeer(link.peer)
		}
	}

	const handlePeerMessage = (link: RoomLink, text: string) => {
		const message = decodePacket(text)
		if (message == null) {
			warnRoom('packet.decode.failed', { length: text.length, linkId: link.id })
			return
		}
		if (room.beaconAuth.handleAuthPacket(link, message)) return
		if (link.source === 'beacon' && link.auth !== 'verified') {
			// Beacon-discovered transports are only candidates until they prove the room secret.
			warnRoom('packet.before-auth', {
				link: linkLog(link),
				type: message.type,
			})
			return
		}

		switch (link.role) {
			case 'host-rendezvous':
				host.handleHostRendezvousMessage(link, message)
				break
			case 'guest-rendezvous':
				guest.handleGuestMessage(link, message)
				break
			case 'mesh':
				// Mesh packets are only meaningful after the link is tied to a participant.
				if (link.remoteId == null) {
					warnRoom('mesh.message.missing-remote', {
						link: linkLog(link),
						type: message.type,
					})
					return
				}

				room.handleCommonMessage(link.remoteId, message)
				break
		}
	}

	const handleLinkMessage = (linkId: LinkId, text: string) => {
		// Every incoming string becomes either auth, setup, or common room activity.
		const link = room.links.get(linkId)
		if (link == null) return

		handlePeerMessage(link, text)
	}

	const handleLinkClose = (linkId: LinkId) => {
		// Close callbacks arrive after many paths; look up the current link before acting.
		const link = room.links.get(linkId)
		if (link == null) return

		infoRoom('link.close', { link: linkLog(link) })
		if (link.remoteId != null) {
			removeParticipantLink(link.remoteId, { peer: link.peer })
			return
		}

		room.removeLink(link)
		if (
			link.role === 'host-rendezvous' &&
			link.source === 'manual' &&
			room.isSelfHost()
		) {
			// A closed manual host invite should be replaced so the host stays joinable.
			void host.startInviteAsHost({ resetPeers: false })
		} else if (
			link.role === 'guest-rendezvous' &&
			link.source === 'beacon' &&
			room.localParticipantId == null
		) {
			return
		} else if (
			link.role === 'guest-rendezvous' &&
			link.source === 'manual' &&
			room.localParticipantId == null
		) {
			const inviteText =
				room.state.connection.side === 'guest'
					? room.state.connection.inviteText
					: ''
			warnRoom('webrtc.direct.failed', {
				link: linkLog(link),
				nextStep: 'fresh-signaling-or-network-change',
			})
			warnRoom('manual.reply.direct-connection.failed', {
				nextStep: 'fresh-reply-or-network-change',
			})
			room.closeAllLinks()
			room.setState('connection', {
				...emptyGuestConnection(),
				inviteText,
				issue: statusCopy.directConnectionFailed,
			})
		} else if (link.role === 'guest-rendezvous') {
			// Losing the host rendezvous before membership means the guest is done here.
			lifecycle.markRoomClosed()
		}
	}

	return { handleLinkClose, handleLinkMessage, handleLinkOpen }
}
