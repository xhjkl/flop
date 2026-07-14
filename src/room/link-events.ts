import { log } from '../log'
import { decodePacket, encodePacket, type ParticipantId } from '../protocol'
import type { RtcPeer } from '../webrtc'
import type { GuestFlow } from './entry/guest'
import type { HostFlow } from './entry/host'
import { emptyGuestJoin } from './initial-state'
import type { RoomLifecycle } from './lifecycle'
import {
	isAdmissionLink,
	isBeaconAdmissionLink,
	isParticipantLink,
	isVerifiedLink,
	type LinkId,
	type RoomLink,
} from './link'
import type { RoomLinkEvents, RoomSession } from './session'

/** Link callbacks that turn WebRTC events into room protocol consequences. */
export const createRoomLinkEvents = (
	room: RoomSession,
	lifecycle: RoomLifecycle,
	host: HostFlow,
	guest: GuestFlow,
): RoomLinkEvents => {
	const removeParticipantLink = (
		participantId: ParticipantId,
		options: { rtc?: RtcPeer | null } = {},
	) => {
		// Link loss can mean "one guest left" or "the whole room ended."
		const link = room.links.forParticipant(participantId)
		if (link == null) return
		if (options.rtc != null && link.rtc !== options.rtc) return

		room.files.abortIncomingFrom(participantId)
		room.links.remove(link)

		if (room.session.isGuest() && participantId === room.session.hostId) {
			lifecycle.markRoomClosed()
			return
		}

		if (room.session.isGuest()) {
			room.mesh.startMissingOffers()
			return
		}

		// Guests can come and go. A guest only loses the room when the host disappears.
		if (room.session.isHost()) {
			room.participants.setIds((ids) =>
				ids.filter((item) => item !== participantId),
			)
			room.participants.setRecords(participantId, void null)
			room.packets.broadcastMembershipChange({ left: participantId })

			if (
				room.links.countOpenParticipants() === 0 &&
				room.links.pending({ side: 'host', via: 'manual' }) == null
			) {
				void host.startInviteAsHost({ resetPeers: false })
			}
		}
	}

	const onOpen = (linkId: LinkId) => {
		// Open transport is not always room membership; beacon auth may still be pending.
		const link = room.links.records.get(linkId)
		if (link == null) return

		link.channelOpen = true
		room.links.notifyChanged()
		log('info', 'room', 'link.open', { link })

		if (isBeaconAdmissionLink(link) && !isVerifiedLink(link)) {
			if (link.purpose.side === 'host') room.auth.sendChallenge(link)
			return
		}

		if (isAdmissionLink(link) && link.purpose.side === 'guest') {
			// Guests say hello first; hosts answer with welcome and identity.
			link.rtc.trySend(encodePacket({ type: 'hello' }))
			return
		}

		if (isParticipantLink(link)) {
			// Reconnected or mesh links should receive the current self presence.
			room.blips.sendLocalToPeer(link.rtc)
			room.packets.sendLocalMediaStateToRtc(link.rtc)
		}
	}

	const handlePeerMessage = (link: RoomLink, text: string) => {
		const message = decodePacket(text)
		if (message == null) {
			log('warn', 'room', 'packet.decode.failed', {
				length: text.length,
				linkId: link.id,
			})
			return
		}
		if (room.auth.handleAuthPacket(link, message)) return
		if (isBeaconAdmissionLink(link) && !isVerifiedLink(link)) {
			// Beacon-discovered transports are only candidates until they prove the room secret.
			log('warn', 'room', 'packet.before-auth', {
				link,
				type: message.type,
			})
			return
		}

		switch (link.purpose.kind) {
			case 'admission':
				if (link.purpose.side === 'host') {
					host.handleHostRendezvousMessage(link, message)
				} else {
					guest.handleGuestMessage(link, message)
				}
				return
			case 'participant':
				if (link.purpose.via === 'admission') {
					// Admission links keep carrying host-owned setup packets after identity lands.
					if (room.session.isHost()) {
						host.handleHostRendezvousMessage(link, message)
					} else {
						guest.handleGuestMessage(link, message)
					}
					return
				}
				room.packets.handleCommon(link.purpose.participantId, message)
				return
		}
	}

	const onMessage = (linkId: LinkId, text: string) => {
		// Every incoming string becomes either auth, setup, or common room activity.
		const link = room.links.records.get(linkId)
		if (link == null) return

		handlePeerMessage(link, text)
	}

	const onClose = (linkId: LinkId) => {
		// Close callbacks arrive after many paths; look up the current link before acting.
		const link = room.links.records.get(linkId)
		if (link == null) return

		log('info', 'room', 'link.close', { link })
		if (isParticipantLink(link)) {
			removeParticipantLink(link.purpose.participantId, { rtc: link.rtc })
			return
		}
		if (!isAdmissionLink(link)) return

		const purpose = link.purpose
		room.links.remove(link)
		if (
			purpose.side === 'host' &&
			purpose.via === 'manual' &&
			room.session.isHost()
		) {
			// A closed manual host invite should be replaced so the host stays joinable.
			void host.startInviteAsHost({ resetPeers: false })
		} else if (
			purpose.side === 'guest' &&
			purpose.via === 'beacon' &&
			room.session.selfId == null
		) {
			return
		} else if (
			purpose.side === 'guest' &&
			purpose.via === 'manual' &&
			room.session.selfId == null
		) {
			const inviteText =
				room.ui.state.entry.side === 'guest'
					? room.ui.state.entry.inviteText
					: ''
			log('warn', 'room', 'webrtc.direct.failed', {
				link,
				nextStep: 'fresh-signaling-or-network-change',
			})
			log('warn', 'room', 'manual.reply.direct-connection.failed', {
				nextStep: 'fresh-reply-or-network-change',
			})
			room.links.closeAll()
			room.ui.setState('entry', {
				...emptyGuestJoin(),
				inviteText,
				issue: 'direct-connection-failed',
			})
		} else if (purpose.side === 'guest') {
			// Losing the host rendezvous before membership means the guest is done here.
			lifecycle.markRoomClosed()
		}
	}

	return { onClose, onMessage, onOpen }
}
