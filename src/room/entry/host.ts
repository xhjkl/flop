import { log } from '../../log'
import { decodeSignal, encodeSignal } from '../../manual-signal-codec'
import type { Packet, ParticipantId } from '../../protocol'
import { type RoomSecret, randomRoomSecret } from '../../rendezvous/secret'
import { projectHostInvite } from '../address-bar'
import { emptyBlipComposer, emptyHostInvite } from '../initial-state'
import { inviteCodeFromSignal, inviteLinkFromSecret } from '../invite'
import type { RoomLifecycle } from '../lifecycle'
import { isParticipantLink, type RoomLink } from '../link'
import { mergeParticipant } from '../participant'
import type { RoomSession } from '../session'
import type { BeaconFlow } from './beacon'
import { MANUAL_ADMISSION_TIMEOUT_MS, watchRendezvousAdmission } from './manual'

/** Host invite start can mint a room or claim an existing link secret. */
export type StartHostOptions = {
	claimed?: boolean
	resetPeers?: boolean
	secret?: RoomSecret | null
}

/** Host-side invite, admission, and manual reply transitions. */
export type HostFlow = {
	acceptReply: (replyText?: string) => Promise<void>
	handleHostPacket: (participantId: ParticipantId, message: Packet) => boolean
	handleHostRendezvousMessage: (link: RoomLink, message: Packet) => void
	startInviteAsHost: (options?: StartHostOptions) => Promise<void>
}

export const createHostFlow = (
	room: RoomSession,
	lifecycle: RoomLifecycle,
	beacon: BeaconFlow,
): HostFlow => {
	const sendHostWelcome = (participantId: ParticipantId) => {
		// Welcome gives the guest its id, host id, and first full roster.
		if (room.session.selfId == null) {
			log('error', 'room', 'welcome.missing-local-host-id', {
				participantId,
			})
			return false
		}
		const sent = room.packets.sendToParticipant(participantId, {
			hostId: room.session.selfId,
			roster: room.participants.roster(),
			selfId: participantId,
			type: 'welcome',
		})
		if (!sent) {
			log('warn', 'room', 'welcome.send.failed', {
				participantId,
			})
			return false
		}
		const link = room.links.forParticipant(participantId)
		if (link != null) {
			room.blips.sendLocalToPeer(link.rtc)
			room.packets.sendLocalMediaStateToRtc(link.rtc)
		}
		return true
	}

	const handleHostPacket = (participantId: ParticipantId, message: Packet) => {
		// Hosts accept room activity and broker mesh setup.
		if (room.packets.handleCommon(participantId, message)) return true
		switch (message.type) {
			case 'hello':
				if (!sendHostWelcome(participantId)) {
					room.participants.remove(participantId)
					return false
				}
				room.packets.broadcastMembershipChange()
				break
			case 'peer-signal':
				// The host introduces guests; it should not become the long-term transport.
				if (message.to === room.session.selfId) {
					log('warn', 'room', 'mesh.signal.addressed-to-host', {
						from: participantId,
						type: message.type,
					})
					return true
				}
				if (
					!room.packets.sendToParticipant(message.to, {
						...message,
						from: participantId,
					})
				) {
					log('warn', 'room', 'mesh.signal.forward.failed', {
						from: participantId,
						to: message.to,
						type: message.type,
					})
				}
				break
			case 'peer-left':
			case 'file-chunk':
			case 'file-end':
			case 'file-start':
			case 'roster':
			case 'blip':
			case 'media-state':
			case 'welcome':
				break
		}
		return true
	}

	const admitHostRendezvous = (link: RoomLink) => {
		// The first hello on a host rendezvous claims a participant slot.
		if (isParticipantLink(link)) {
			return { fresh: false, participantId: link.purpose.participantId }
		}

		const participantId = room.participants.allocateId()
		const person = mergeParticipant(participantId)
		room.participants.setRecords(person.id, person)
		room.participants.setIds((ids) =>
			ids.includes(person.id) ? ids : [...ids, person.id],
		)
		if (!beacon.promoteAdmissionLink(link, participantId)) {
			log('error', 'room', 'host.admit.adopt-link.failed', {
				link,
				participantId,
			})
			room.participants.remove(participantId)
			return null
		}

		if (room.ui.state.entry.side === 'host') {
			room.ui.setState('entry', {
				...room.ui.state.entry,
				issue: null,
				replyText: '',
			})
		}
		log('info', 'room', 'host.admit', {
			link,
			participantId,
		})
		return { fresh: true, participantId }
	}

	const startInviteAsHost = async (
		options: StartHostOptions = { resetPeers: true },
	) => {
		// Invite flow: every host room prepares the link path and the code path.
		const version = room.session.nextSignalingGeneration()
		const resetPeers = options.resetPeers ?? true
		let nextLink: RoomLink | null = null

		try {
			if (resetPeers) {
				// A full host restart means a new room, not a new invite for old peers.
				lifecycle.resetAsHost({ secret: options.secret ?? null })
				room.ui.setState('blipComposer', emptyBlipComposer())
			} else if (room.session.selfId == null || room.session.hostId == null) {
				lifecycle.resetAsHost({ secret: options.secret ?? null })
			} else {
				room.links.closePending({ side: 'host', via: 'manual' })
			}

			if (options.claimed && room.session.selfId != null) {
				log('info', 'room', 'invite.link.claimed', {
					hostId: room.session.selfId,
				})
			}
			// One secret powers all invite link attempts for this host room.
			const secret =
				room.session.inviteSecret ?? options.secret ?? randomRoomSecret()
			room.session.inviteSecret = secret
			const inviteLink = inviteLinkFromSecret(secret)
			projectHostInvite(secret, inviteLink)
			room.ui.setState('entry', {
				...emptyHostInvite(),
				inviteLink,
				inviteLinkStatus: 'finding',
			})
			void beacon.startBeaconClient(secret, 'host', version)

			nextLink = room.links.create({
				kind: 'admission',
				side: 'host',
				via: 'manual',
			})
			// The invite code is a one-shot offer waiting for one guest reply.
			const offer = await nextLink.rtc.createOffer()
			const inviteSignal = await encodeSignal(offer)
			if (
				!room.session.isCurrentSignalingGeneration(version) ||
				room.links.pending({ side: 'host', via: 'manual' }) !== nextLink
			) {
				room.links.close(nextLink)
				return
			}

			const inviteCode = inviteCodeFromSignal(inviteSignal)
			room.ui.setState('entry', {
				...emptyHostInvite(),
				inviteCode,
				inviteLink,
				inviteLinkStatus:
					room.ui.state.entry.side === 'host'
						? room.ui.state.entry.inviteLinkStatus
						: 'finding',
				status: 'invite-ready',
			})
		} catch (error) {
			log('warn', 'room', 'invite.create.failed', { error })
			if (nextLink != null) room.links.close(nextLink)
			if (!room.session.isCurrentSignalingGeneration(version)) return
			room.ui.setState('entry', {
				...(room.ui.state.entry.side === 'host'
					? room.ui.state.entry
					: emptyHostInvite()),
				issue: 'invite-creation-failed',
			})
		}
	}

	const watchManualAdmission = (link: RoomLink, version: number) => {
		watchRendezvousAdmission({
			delayMs: MANUAL_ADMISSION_TIMEOUT_MS,
			link,
			linkStillCurrent: (candidate) =>
				room.links.records.get(candidate.id) === candidate,
			stillWaiting: () => true,
			version,
			versionStillCurrent: room.session.isCurrentSignalingGeneration,
			onTimeout: () => {
				log('warn', 'room', 'manual.admission.timeout', {
					link,
					nextStep: 'fresh-signaling-or-network-change',
				})
				room.links.close(link)
				if (room.ui.state.entry.side === 'host') {
					room.ui.setState('entry', {
						...room.ui.state.entry,
						issue: 'host-reply-failed',
						status: 'invite-ready',
					})
				}
				void startInviteAsHost({ resetPeers: false }).then(() => {
					if (room.ui.state.entry.side !== 'host') return

					room.ui.setState('entry', {
						...room.ui.state.entry,
						issue: 'host-reply-failed',
					})
				})
			},
		})
	}

	const handleHostRendezvousMessage = (link: RoomLink, message: Packet) => {
		// Host rendezvous packets may be pre-admission or normal guest packets.
		let participantId = isParticipantLink(link)
			? link.purpose.participantId
			: null
		let fresh = false
		if (participantId == null && message.type === 'hello') {
			const admission = admitHostRendezvous(link)
			if (admission == null) return

			participantId = admission.participantId
			fresh = admission.fresh
		}

		if (participantId == null) {
			log('warn', 'room', 'host.rendezvous.message-before-hello', {
				link,
				type: message.type,
			})
			return
		}

		const participantRetained = handleHostPacket(participantId, message)
		if (fresh || !participantRetained) {
			// Keep the host ready for the next person only after this peer joined the room protocol.
			void startInviteAsHost({ resetPeers: false })
		}
	}

	const acceptReply = async (replyText?: string) => {
		// The host finishes the manual handshake by accepting the guest answer.
		const replyCode = (
			replyText ??
			(room.ui.state.entry.side === 'host' ? room.ui.state.entry.replyText : '')
		).trim()
		const answeringLink = room.links.pending({ side: 'host', via: 'manual' })
		if (replyCode === '' || answeringLink == null) return

		const version = room.session.signalingGeneration

		try {
			if (room.ui.state.entry.side === 'host') {
				room.ui.setState('entry', {
					...room.ui.state.entry,
					issue: null,
					replyText: replyCode,
					status: 'accepting-reply',
				})
			}

			const answer = await decodeSignal(replyCode)
			if (answer.type !== 'answer') {
				throw new Error('Reply code did not contain an answer')
			}
			await answeringLink.rtc.acceptAnswer(answer)
			if (!room.session.isCurrentSignalingGeneration(version)) return

			watchManualAdmission(answeringLink, version)
		} catch (error) {
			log('warn', 'room', 'manual.reply.direct-connection.failed', {
				error,
				nextStep: 'fresh-reply-or-network-change',
			})
			if (!room.session.isCurrentSignalingGeneration(version)) return
			if (room.ui.state.entry.side === 'host') {
				room.ui.setState('entry', {
					...room.ui.state.entry,
					issue: 'host-reply-failed',
					status: 'invite-ready',
				})
			}
		}
	}

	return {
		acceptReply,
		handleHostPacket,
		handleHostRendezvousMessage,
		startInviteAsHost,
	}
}
