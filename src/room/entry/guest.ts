import { log } from '../../log'
import { decodeSignal, encodeSignal } from '../../manual-signal-codec'
import type { Packet, ParticipantId, Roster } from '../../protocol'
import type { RoomSecret } from '../../rendezvous/secret'
import { emptyBlipComposer, emptyGuestJoin } from '../initial-state'
import { inviteFromInput, inviteLinkFromSecret } from '../invite'
import type { RoomLifecycle } from '../lifecycle'
import { isBeaconCandidate, isParticipantLink, type RoomLink } from '../link'
import { RelayQuotaExceededError, requestRelayIceServers } from '../relay'
import type { RoomSession } from '../session'
import type { BeaconFlow } from './beacon'
import type { HostFlow } from './host'
import { MANUAL_ADMISSION_TIMEOUT_MS, watchRendezvousAdmission } from './manual'
import { guestFindingLinkEntry } from './state'

/** Guest-side invite consumption, welcome, and room roster transitions. */
export type GuestFlow = {
	becomeGuest: () => void
	canClaimFindingInviteLink: () => boolean
	claimInviteLinkAsHost: () => void
	createReply: (inviteText?: string) => Promise<void>
	handleGuestMessage: (link: RoomLink, message: Packet) => void
	joinRoomWithInviteLink: (secret: RoomSecret) => void
	tryRelay: () => Promise<void>
}

export const createGuestFlow = (
	room: RoomSession,
	lifecycle: RoomLifecycle,
	beacon: BeaconFlow,
	host: HostFlow,
): GuestFlow => {
	const applyRoster = (roster: Roster) => {
		// If the host is gone from the roster, the room is gone for guests.
		if (room.session.hostId != null && !roster.includes(room.session.hostId)) {
			log('warn', 'room', 'roster.missing-host', {
				hostId: room.session.hostId,
			})
			lifecycle.markRoomClosed()
			return
		}

		room.participants.replace(roster)
		room.mesh.startMissingOffers()
	}

	let relayRequest: Promise<void> | null = null

	const closeGuestBeaconCandidates = () => {
		for (const link of [...room.links.records.values()]) {
			if (!isBeaconCandidate(link, 'guest')) continue

			room.links.close(link)
		}
	}

	const findingInviteLinkSecret = () => {
		return guestFindingLinkEntry(room.ui.state.entry) == null
			? null
			: room.session.inviteSecret
	}

	const stillFindingInviteLink = (secret: RoomSecret, version: number) => {
		return (
			room.session.isCurrentSignalingGeneration(version) &&
			room.session.inviteSecret === secret &&
			guestFindingLinkEntry(room.ui.state.entry) != null
		)
	}

	const removeGuestRosterParticipant = (participantId: ParticipantId) => {
		// Roster leaves are host-approved; close any direct link we had.
		if (participantId === room.session.hostId) {
			lifecycle.markRoomClosed()
			return
		}

		room.files.abortIncomingFrom(participantId)
		room.participants.remove(participantId)
	}

	const handleGuestMessage = (link: RoomLink, message: Packet) => {
		// Before welcome, the rendezvous link itself is the best sender hint.
		const senderId =
			room.session.hostId ??
			(isParticipantLink(link) ? link.purpose.participantId : null)
		if (senderId != null && room.packets.handleCommon(senderId, message)) return

		switch (message.type) {
			case 'welcome':
				// Welcome is the handoff from paste-code UX into actual room membership.
				room.session.selfId = message.selfId
				room.session.hostId = message.hostId
				room.session.stopBeacon()
				room.ui.setState('themeSeed', message.hostId)
				room.participants.replace(message.roster)
				room.blips.applyPending()
				if (!beacon.promoteAdmissionLink(link, message.hostId)) {
					log('error', 'room', 'guest.welcome.adopt-link.failed', {
						hostId: message.hostId,
						link,
					})
					lifecycle.markRoomClosed()
					return
				}
				room.ui.setState('entry', {
					...(room.ui.state.entry.side === 'guest'
						? room.ui.state.entry
						: emptyGuestJoin()),
					issue: null,
					status: 'connected',
				})
				room.blips.publishLocal()
				room.packets.publishLocalMediaState()
				room.mesh.startMissingOffers()
				break
			case 'roster':
				applyRoster(message.roster)
				break
			case 'peer-signal':
				void room.mesh.acceptSignal(message)
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
		const version = room.session.nextSignalingGeneration()
		lifecycle.resetBeforeJoining({ keepPendingBlip: true })
		room.session.inviteSecret = secret
		room.ui.setState('entry', {
			...emptyGuestJoin(),
			inviteText: inviteLinkFromSecret(secret),
			status: 'finding-link',
		})
		void beacon.startBeaconClient(secret, 'guest', version)
	}

	const tryRelay = () => {
		if (relayRequest != null) return relayRequest

		relayRequest = (async () => {
			const secret = findingInviteLinkSecret()
			if (secret == null) return
			const startingVersion = room.session.signalingGeneration

			try {
				const iceServers = await requestRelayIceServers()
				if (!stillFindingInviteLink(secret, startingVersion)) return

				const version = room.session.nextSignalingGeneration()
				closeGuestBeaconCandidates()
				room.relay.start(iceServers, () =>
					lifecycle.markRoomClosed({ keepRelayMetering: true }),
				)
				const entry = guestFindingLinkEntry(room.ui.state.entry)
				if (entry == null) return

				room.ui.setState('entry', {
					...entry,
					issue: null,
					relayFallbackSecondsLeft: null,
				})
				void beacon.startBeaconClient(secret, 'guest', version)
			} catch (error) {
				log('warn', 'room', 'relay.start.failed', { error })
				if (!stillFindingInviteLink(secret, startingVersion)) return

				const entry = guestFindingLinkEntry(room.ui.state.entry)
				if (entry == null) return

				room.ui.setState('entry', {
					...entry,
					issue:
						error instanceof RelayQuotaExceededError
							? 'relay-quota-exceeded'
							: 'relay-unavailable',
					relayFallbackSecondsLeft: null,
				})
			}
		})().finally(() => {
			relayRequest = null
		})

		return relayRequest
	}

	const canClaimFindingInviteLink = () => {
		// Claiming is safe only after presence confirms the secret has no host.
		const entry = guestFindingLinkEntry(room.ui.state.entry)
		return (
			room.session.inviteSecret != null &&
			entry != null &&
			entry.issue == null &&
			entry.inviteLinkPresence?.hosts === 0
		)
	}

	const claimInviteLinkAsHost = () => {
		if (!canClaimFindingInviteLink()) return

		const secret = room.session.inviteSecret
		if (secret == null) return

		void host.startInviteAsHost({
			claimed: true,
			resetPeers: true,
			secret,
		})
	}

	const becomeGuest = () => {
		// Switching sides abandons host identity and any old invites.
		room.session.nextSignalingGeneration()
		lifecycle.resetBeforeJoining()
		room.ui.setState('entry', emptyGuestJoin())
		room.ui.setState('blipComposer', emptyBlipComposer())
	}

	const watchReplyAdmission = (link: RoomLink, version: number) => {
		watchRendezvousAdmission({
			delayMs: MANUAL_ADMISSION_TIMEOUT_MS,
			link,
			linkStillCurrent: (candidate) =>
				room.links.records.get(candidate.id) === candidate,
			stillWaiting: () =>
				room.ui.state.entry.side === 'guest' &&
				room.ui.state.entry.status === 'reply-ready',
			version,
			versionStillCurrent: room.session.isCurrentSignalingGeneration,
			onTimeout: () => {
				log('warn', 'room', 'manual.admission.waiting', {
					link,
					nextStep: 'resend-reply-or-fresh-invite',
				})
				if (room.ui.state.entry.side !== 'guest') return

				room.ui.setState('entry', {
					...room.ui.state.entry,
					issue: 'reply-still-waiting',
				})
			},
		})
	}

	const createReply = async (inviteText?: string) => {
		// Guest paste decides the path: invite link or manual answer code.
		const inviteInput = (
			inviteText ??
			(room.ui.state.entry.side === 'guest'
				? room.ui.state.entry.inviteText
				: '')
		).trim()
		const invite = inviteFromInput(inviteInput)
		if (invite.type === 'empty') return
		if (invite.type === 'invite-link') {
			joinRoomWithInviteLink(invite.secret)
			return
		}

		const version = room.session.nextSignalingGeneration()
		let nextLink: RoomLink | null = null

		try {
			lifecycle.resetBeforeJoining({ keepPendingBlip: true })
			room.ui.setState('entry', {
				...emptyGuestJoin(),
				inviteText: inviteInput,
				status: 'creating-reply',
			})

			nextLink = room.links.create({
				kind: 'admission',
				side: 'guest',
				via: 'manual',
			})
			// Manual reply turns the host's offer into an answer they can paste back.
			const offer = await decodeSignal(invite.code)
			if (offer.type !== 'offer') {
				throw new Error('Invite code did not contain an offer')
			}
			const answer = await nextLink.rtc.createAnswer(offer)
			const replyCode = await encodeSignal(answer)
			if (
				!room.session.isCurrentSignalingGeneration(version) ||
				room.links.pending({ side: 'guest', via: 'manual' }) !== nextLink
			) {
				room.links.close(nextLink)
				return
			}

			room.ui.setState('entry', {
				...emptyGuestJoin(),
				inviteText: inviteInput,
				replyCode,
				status: 'reply-ready',
			})
			watchReplyAdmission(nextLink, version)
		} catch (error) {
			log('warn', 'room', 'reply.create.failed', { error })
			if (nextLink != null) room.links.close(nextLink)
			if (!room.session.isCurrentSignalingGeneration(version)) return
			room.links.closeAll()
			room.ui.setState('entry', {
				...emptyGuestJoin(),
				inviteText: inviteInput,
				issue: 'invite-invalid',
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
		tryRelay,
	}
}
