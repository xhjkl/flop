import { log } from '../log'
import {
	type Packet,
	type ParticipantId,
	participantIdToString,
} from '../protocol'
import { randomRoomSecret } from '../rendezvous/secret'
import { decodeSignal, encodeSignal } from '../signal'
import { projectHostInvite } from './address-bar'
import type { BeaconFlow } from './beacon-flow'
import { emptyBlipComposer, emptyHostConnection } from './initial-state'
import { inviteCodeFromSignal, inviteLinkFromSecret } from './invite'
import type { RoomLifecycle } from './lifecycle'
import type { RoomLink } from './link'
import { MANUAL_ADMISSION_TIMEOUT_MS, watchRendezvousAdmission } from './manual'
import { mergeParticipant } from './participant'
import type { RoomRuntime } from './runtime'
import { statusCopy } from './status-copy'
import type { StartHostOptions } from './types'

/** Host-side invite, admission, and manual reply transitions. */
export type HostFlow = {
	acceptReply: (replyText?: string) => Promise<void>
	handleHostPacket: (participantId: ParticipantId, message: Packet) => void
	handleHostRendezvousMessage: (link: RoomLink, message: Packet) => void
	startInviteAsHost: (options?: StartHostOptions) => Promise<void>
}

export const createHostFlow = (
	room: RoomRuntime,
	lifecycle: RoomLifecycle,
	beacon: BeaconFlow,
): HostFlow => {
	const sendHostWelcome = (participantId: ParticipantId) => {
		// Welcome gives the guest its id, host id, and first full roster.
		if (room.localParticipantId == null) {
			log('error', 'room', 'welcome.missing-local-host-id', {
				participantId: participantIdToString(participantId),
			})
			return
		}
		const sent = room.sendToParticipant(participantId, {
			hostId: room.localParticipantId,
			roster: room.roomRoster(),
			selfId: participantId,
			type: 'welcome',
		})
		if (!sent) {
			log('warn', 'room', 'welcome.send.failed', {
				participantId: participantIdToString(participantId),
			})
			const link = room.participantLink(participantId)
			if (link != null) room.closeLink(link)
			return
		}
		const link = room.participantLink(participantId)
		if (link != null) {
			room.blips.sendLocalToPeer(link.peer)
			room.sendLocalMediaStateToPeer(link.peer)
		}
	}

	const handleHostPacket = (participantId: ParticipantId, message: Packet) => {
		// Hosts accept room activity and broker mesh setup.
		if (room.handleCommonMessage(participantId, message)) return
		switch (message.type) {
			case 'hello':
				sendHostWelcome(participantId)
				room.broadcastMembershipChange()
				break
			case 'peer-offer':
			case 'peer-answer':
				// The host introduces guests; it should not become the long-term transport.
				if (message.to === room.localParticipantId) {
					log('warn', 'room', 'mesh.signal.addressed-to-host', {
						from: participantIdToString(participantId),
						type: message.type,
					})
					return
				}
				if (
					!room.sendToParticipant(message.to, {
						...message,
						from: participantId,
					})
				) {
					log('warn', 'room', 'mesh.signal.forward.failed', {
						from: participantIdToString(participantId),
						to: participantIdToString(message.to),
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
	}

	const admitHostRendezvous = (link: RoomLink) => {
		// The first hello on a host rendezvous claims a participant slot.
		const existingId = link.remoteId
		if (existingId != null) {
			return { fresh: false, participantId: existingId }
		}

		const participant = room.assignGuestParticipant()
		const person = mergeParticipant(participant)
		room.setParticipants(person.id, person)
		room.setParticipantKeys((keys) =>
			keys.includes(person.id) ? keys : [...keys, person.id],
		)
		if (!beacon.promoteRendezvousLink(link, participant.id)) {
			log('error', 'room', 'host.admit.adopt-link.failed', {
				link,
				participantId: participantIdToString(participant.id),
			})
			room.deleteParticipant(participant.id)
			return null
		}

		if (room.state.connection.side === 'host') {
			room.setState('connection', {
				...room.state.connection,
				issue: null,
				replyText: '',
			})
		}
		log('info', 'room', 'host.admit', {
			link,
			participantId: participantIdToString(participant.id),
		})
		return { fresh: true, participantId: participant.id }
	}

	const startInviteAsHost = async (
		options: StartHostOptions = { resetPeers: true },
	) => {
		// Invite flow: every host room prepares the link path and the code path.
		const version = room.nextSignalingVersion()
		const resetPeers = options.resetPeers ?? true
		let nextLink: RoomLink | null = null

		try {
			if (resetPeers) {
				// A full host restart means a new room, not a new invite for old peers.
				lifecycle.resetAsHost({ secret: options.secret ?? null })
				room.setState('blipComposer', emptyBlipComposer())
			} else if (
				room.localParticipantId == null ||
				room.hostParticipantId == null
			) {
				lifecycle.resetAsHost({ secret: options.secret ?? null })
			} else {
				room.closeRendezvousLink('host-rendezvous', 'manual')
			}

			if (options.claimed && room.localParticipantId != null) {
				log('info', 'room', 'invite.link.claimed', {
					hostId: participantIdToString(room.localParticipantId),
				})
			}
			if (room.roomSecret == null) {
				room.roomSecret = options.secret ?? randomRoomSecret()
			}
			// One secret powers all invite link attempts for this host room.
			const secret = room.roomSecret
			const inviteLink = inviteLinkFromSecret(secret)
			projectHostInvite(secret, inviteLink)
			room.setState('connection', {
				...emptyHostConnection(),
				inviteLink,
				inviteLinkStatus: 'finding',
			})
			void beacon.startBeaconRendezvous(secret, 'host', version)

			nextLink = room.createLink('host-rendezvous', { source: 'manual' })
			// The invite code is a one-shot offer waiting for one guest reply.
			const offer = await nextLink.peer.createOffer()
			const inviteSignal = await encodeSignal(offer)
			if (
				!room.isCurrentSignalingVersion(version) ||
				room.currentRendezvousLink('host-rendezvous', 'manual') !== nextLink
			) {
				room.closeLink(nextLink)
				return
			}

			const inviteCode = inviteCodeFromSignal(inviteSignal)
			room.setState('connection', {
				...emptyHostConnection(),
				inviteCode,
				inviteLink,
				inviteLinkStatus:
					room.state.connection.side === 'host'
						? room.state.connection.inviteLinkStatus
						: 'finding',
				status: 'invite-ready',
			})
		} catch (error) {
			log('warn', 'room', 'invite.create.failed', { error })
			if (nextLink != null) room.closeLink(nextLink)
			if (!room.isCurrentSignalingVersion(version)) return
			room.setState('connection', {
				...(room.state.connection.side === 'host'
					? room.state.connection
					: emptyHostConnection()),
				issue: 'Could not create an invite link or invite code.',
			})
		}
	}

	const watchManualAdmission = (link: RoomLink, version: number) => {
		watchRendezvousAdmission({
			delayMs: MANUAL_ADMISSION_TIMEOUT_MS,
			link,
			linkStillCurrent: (candidate) =>
				room.links.get(candidate.id) === candidate,
			stillWaiting: () => true,
			version,
			versionStillCurrent: room.isCurrentSignalingVersion,
			onTimeout: () => {
				log('warn', 'room', 'manual.admission.timeout', {
					link,
					nextStep: 'fresh-signaling-or-network-change',
				})
				room.closeLink(link)
				if (room.state.connection.side === 'host') {
					room.setState('connection', {
						...room.state.connection,
						issue: statusCopy.hostReplyFailed,
						status: 'invite-ready',
					})
				}
				void startInviteAsHost({ resetPeers: false }).then(() => {
					if (room.state.connection.side !== 'host') return

					room.setState('connection', {
						...room.state.connection,
						issue: statusCopy.hostReplyFailed,
					})
				})
			},
		})
	}

	const handleHostRendezvousMessage = (link: RoomLink, message: Packet) => {
		// Host rendezvous packets may be pre-admission or normal guest packets.
		let participantId = link.remoteId
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

		handleHostPacket(participantId, message)
		if (fresh) {
			// Keep the host ready for the next person only after this peer joined the room protocol.
			void startInviteAsHost({ resetPeers: false })
		}
	}

	const acceptReply = async (replyText?: string) => {
		// The host finishes the manual handshake by accepting the guest answer.
		const replyCode = (
			replyText ??
			(room.state.connection.side === 'host'
				? room.state.connection.replyText
				: '')
		).trim()
		const answeringLink = room.currentRendezvousLink(
			'host-rendezvous',
			'manual',
		)
		if (replyCode === '' || answeringLink == null) return

		const version = room.signalingVersion

		try {
			if (room.state.connection.side === 'host') {
				room.setState('connection', {
					...room.state.connection,
					issue: null,
					replyText: replyCode,
					status: 'accepting-reply',
				})
			}

			const answer = await decodeSignal(replyCode)
			await answeringLink.peer.acceptAnswer(answer)
			if (!room.isCurrentSignalingVersion(version)) return

			watchManualAdmission(answeringLink, version)
		} catch (error) {
			log('warn', 'room', 'manual.reply.direct-connection.failed', {
				error,
				nextStep: 'fresh-reply-or-network-change',
			})
			if (!room.isCurrentSignalingVersion(version)) return
			if (room.state.connection.side === 'host') {
				room.setState('connection', {
					...room.state.connection,
					issue: statusCopy.hostReplyFailed,
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
