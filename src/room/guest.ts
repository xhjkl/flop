import {
	type Packet,
	type Participant,
	type ParticipantId,
	participantIdToString,
} from '../protocol'
import type { RoomSecret } from '../rendezvous/secret'
import { decodeSignal, encodeSignal } from '../signal'
import type { BeaconFlow } from './beacon-flow'
import type { HostFlow } from './host'
import { emptyBlipComposer, emptyGuestConnection } from './initial-state'
import { inviteFromInput, inviteLinkFromSecret } from './invite'
import type { RoomLifecycle } from './lifecycle'
import type { RoomLink } from './link'
import { errorRoom, linkLog, warnRoom } from './log'
import { MANUAL_ADMISSION_TIMEOUT_MS } from './manual'
import { participantKey } from './participant'
import type { RoomRuntime } from './runtime'
import { statusCopy } from './status-copy'

/** Guest-side invite consumption, welcome, and room roster transitions. */
export type GuestFlow = {
	becomeGuest: () => void
	canClaimFindingInviteLink: () => boolean
	claimInviteLinkAsHost: () => void
	createReply: (inviteText?: string) => Promise<void>
	handleGuestMessage: (link: RoomLink, message: Packet) => void
	joinRoomWithInviteLink: (secret: RoomSecret) => void
}

export const createGuestFlow = (
	room: RoomRuntime,
	lifecycle: RoomLifecycle,
	beacon: BeaconFlow,
	host: HostFlow,
): GuestFlow => {
	const applyRoster = (roster: Participant[]) => {
		// If the host is gone from the roster, the room is gone for guests.
		if (
			room.hostParticipantId != null &&
			!roster.some((p) => p.id === room.hostParticipantId)
		) {
			warnRoom('roster.missing-host', {
				hostId: participantIdToString(room.hostParticipantId),
			})
			lifecycle.markRoomClosed()
			return
		}

		room.replaceParticipants(roster)
		room.mesh.startMissingOffers()
	}

	const removeGuestRosterParticipant = (participantId: ParticipantId) => {
		// Roster leaves are host-approved; close any direct link we had.
		if (participantId === room.hostParticipantId) {
			lifecycle.markRoomClosed()
			return
		}

		room.fileTransfers.abortIncomingFrom(participantId)
		room.deleteParticipant(participantId)?.peer.close()
	}

	const handleGuestMessage = (link: RoomLink, message: Packet) => {
		// Before welcome, the rendezvous link itself is the best sender hint.
		const senderId = room.hostParticipantId ?? link.remoteId
		if (senderId != null && room.handleCommonMessage(senderId, message)) return

		switch (message.type) {
			case 'welcome':
				// Welcome is the handoff from paste-code UX into actual room membership.
				room.localParticipantId = message.selfId
				room.hostParticipantId = message.hostId
				room.stopBeaconRendezvous()
				room.setState('themeSeed', participantIdToString(message.hostId))
				room.setLocalKey(participantKey(message.selfId))
				room.replaceParticipants(message.roster)
				room.blips.applyPending()
				if (!beacon.promoteRendezvousLink(link, message.hostId)) {
					errorRoom('guest.welcome.adopt-link.failed', {
						hostId: participantIdToString(message.hostId),
						link: linkLog(link),
					})
					lifecycle.markRoomClosed()
					return
				}
				room.setState('connection', {
					...(room.state.connection.side === 'guest'
						? room.state.connection
						: emptyGuestConnection()),
					issue: null,
					status: 'connected',
				})
				room.blips.publishLocal()
				room.publishLocalMediaState()
				room.mesh.startMissingOffers()
				break
			case 'roster':
				applyRoster(message.roster)
				break
			case 'peer-offer':
				void room.mesh.acceptOffer(message)
				break
			case 'peer-answer':
				void room.mesh.acceptAnswer(message)
				break
			case 'peer-left':
				removeGuestRosterParticipant(message.id)
				break
			case 'file-chunk':
			case 'file-end':
			case 'file-start':
			case 'hello':
			case 'blip':
			case 'media-state':
				break
		}
	}

	const joinRoomWithInviteLink = (secret: RoomSecret) => {
		// Opening an invite link makes the guest wait for the host, no reply code needed.
		const version = ++room.signalingVersion
		lifecycle.resetBeforeJoining({ keepPendingBlip: true })
		room.roomSecret = secret
		room.setState('connection', {
			...emptyGuestConnection(),
			inviteText: inviteLinkFromSecret(secret),
			status: 'finding-link',
		})
		void beacon.startBeaconRendezvous(secret, 'guest', version)
	}

	const canClaimFindingInviteLink = () => {
		// Claiming is safe only after presence confirms the secret has no host.
		return (
			room.roomSecret != null &&
			room.state.connection.side === 'guest' &&
			room.state.connection.status === 'finding-link' &&
			room.state.connection.issue == null &&
			room.state.connection.inviteLinkPresence?.hosts === 0
		)
	}

	const claimInviteLinkAsHost = () => {
		if (!canClaimFindingInviteLink()) return

		const secret = room.roomSecret
		if (secret == null) return

		void host.startInviteAsHost({
			claimed: true,
			resetPeers: true,
			secret,
		})
	}

	const becomeGuest = () => {
		// Switching sides abandons host identity and any old invites.
		room.signalingVersion++
		lifecycle.resetBeforeJoining()
		room.setState('connection', emptyGuestConnection())
		room.setState('blipComposer', emptyBlipComposer())
	}

	const watchReplyAdmission = (link: RoomLink, version: number) => {
		setTimeout(() => {
			if (version !== room.signalingVersion) return
			if (room.links.get(link.id) !== link) return
			if (link.remoteId != null) return
			if (
				room.state.connection.side !== 'guest' ||
				room.state.connection.status !== 'reply-ready'
			) {
				return
			}

			warnRoom('manual.admission.waiting', {
				link: linkLog(link),
				nextStep: 'resend-reply-or-fresh-invite',
			})
			room.setState('connection', {
				...room.state.connection,
				issue: statusCopy.replyStillWaiting,
			})
		}, MANUAL_ADMISSION_TIMEOUT_MS)
	}

	const createReply = async (inviteText?: string) => {
		// Guest paste decides the path: invite link or manual answer code.
		const inviteInput = (
			inviteText ??
			(room.state.connection.side === 'guest'
				? room.state.connection.inviteText
				: '')
		).trim()
		const invite = inviteFromInput(inviteInput)
		if (invite.type === 'empty') return
		if (invite.type === 'invite-link') {
			joinRoomWithInviteLink(invite.secret)
			return
		}

		const version = ++room.signalingVersion
		let nextLink: RoomLink | null = null

		try {
			lifecycle.resetBeforeJoining({ keepPendingBlip: true })
			room.setState('connection', {
				...emptyGuestConnection(),
				inviteText: inviteInput,
				status: 'creating-reply',
			})

			nextLink = room.createLink('guest-rendezvous', { source: 'manual' })
			// Manual reply turns the host's offer into an answer they can paste back.
			const offer = await decodeSignal(invite.code)
			const answer = await nextLink.peer.createAnswer(offer)
			const replyCode = await encodeSignal(answer)
			if (
				version !== room.signalingVersion ||
				room.currentRendezvousLink('guest-rendezvous', 'manual') !== nextLink
			) {
				room.closeLink(nextLink)
				return
			}

			room.setState('connection', {
				...emptyGuestConnection(),
				inviteText: inviteInput,
				replyCode,
				status: 'reply-ready',
			})
			watchReplyAdmission(nextLink, version)
		} catch (error) {
			warnRoom('reply.create.failed', { error })
			if (nextLink != null) room.closeLink(nextLink)
			if (version !== room.signalingVersion) return
			room.closeAllLinks()
			room.setState('connection', {
				...emptyGuestConnection(),
				inviteText: inviteInput,
				issue: statusCopy.inviteFailed,
			})
		}
	}

	return {
		becomeGuest,
		canClaimFindingInviteLink,
		claimInviteLinkAsHost,
		createReply,
		handleGuestMessage,
		joinRoomWithInviteLink,
	}
}
