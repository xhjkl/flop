import { log } from '../log'
import { type ParticipantId, participantIdToString } from '../protocol'
import {
	type BeaconPresence,
	type BeaconStatus,
	createBeaconRendezvous,
} from '../rendezvous/beacon'
import { deriveRoomKeys } from '../rendezvous/crypto'
import type { RoomSecret } from '../rendezvous/secret'
import type { AnswerDescription, OfferDescription } from '../signal'
import { guestFindingLinkConnection } from '../state'
import {
	isBeaconCandidate,
	isBeaconLink,
	isVerifiedLink,
	type LinkRole,
	type RoomLink,
} from './link'
import { createRelayFallbackTimer } from './relay'
import type { RoomRuntime } from './runtime'
import { statusCopy } from './status-copy'

const BEACON_CANDIDATE_LIMIT = 12
const BEACON_CANDIDATE_TTL_MS = 45_000

/** Invite-link discovery and secret proof candidates. */
export type BeaconFlow = {
	promoteRendezvousLink: (
		link: RoomLink,
		participantId: ParticipantId,
	) => boolean
	startBeaconRendezvous: (
		secret: RoomSecret,
		role: 'guest' | 'host',
		version: number,
	) => Promise<void>
}

export const createBeaconFlow = (room: RoomRuntime): BeaconFlow => {
	const findingLinkConnection = () =>
		guestFindingLinkConnection(room.state.connection)

	const setGuestRelayFallbackSeconds = (seconds: number | null) => {
		const connection = findingLinkConnection()
		if (connection == null) return

		room.setState('connection', {
			...connection,
			relayFallbackSecondsLeft: seconds,
		})
	}

	const relayFallback = createRelayFallbackTimer({
		active: room.relay.active,
		currentSecondsLeft: () =>
			findingLinkConnection()?.relayFallbackSecondsLeft ?? null,
		finding: () => findingLinkConnection() != null,
		setSecondsLeft: setGuestRelayFallbackSeconds,
	})

	const beaconCandidates = (role: LinkRole) => {
		// Candidate order is insertion order; oldest loses when the budget is full.
		return [...room.links.values()].filter((link) =>
			isBeaconCandidate(link, role),
		)
	}

	const candidateBudgetAllows = (role: LinkRole) => {
		return beaconCandidates(role).length < BEACON_CANDIDATE_LIMIT
	}

	const expireBeaconCandidate = (link: RoomLink, reason: string) => {
		// Dead candidates should disappear quietly from the portrait projection.
		if (room.links.get(link.id) !== link) return
		if (!isBeaconCandidate(link)) return

		log('info', 'room', 'beacon.candidate.expired', {
			link,
			reason,
		})
		room.closeLink(link)
	}

	const pruneBeaconCandidateBudget = (role: LinkRole) => {
		while (!candidateBudgetAllows(role)) {
			const oldest = beaconCandidates(role)[0]
			if (oldest == null) return

			expireBeaconCandidate(oldest, 'budget')
		}
	}

	const createBeaconCandidate = (
		role: LinkRole,
		options: { beaconPeerId?: string | null; offerId?: string | null } = {},
	) => {
		// Beacon offers are speculative. Keep only a small bench of hopeful links.
		pruneBeaconCandidateBudget(role)
		if (!candidateBudgetAllows(role)) {
			log('warn', 'room', 'beacon.candidate.budget-full', { role })
			return null
		}

		const link = room.createLink(role, {
			beaconPeerId: options.beaconPeerId ?? null,
			source: 'beacon',
		})
		if (options.offerId != null) room.beaconOffers.set(options.offerId, link)

		setTimeout(() => {
			expireBeaconCandidate(link, 'timeout')
		}, BEACON_CANDIDATE_TTL_MS)
		return link
	}

	const promoteRendezvousLink = (
		link: RoomLink,
		participantId: ParticipantId,
	) => {
		// Beacon discovery earns a room seat only after auth proves the secret.
		if (isBeaconLink(link) && !isVerifiedLink(link)) {
			log('warn', 'room', 'beacon.candidate.promote.before-auth', {
				link,
				participantId: participantIdToString(participantId),
			})
			room.closeLink(link)
			return false
		}

		if (!room.adoptLink(link, participantId)) return false

		room.closeSiblingRendezvousLinks(link)
		return true
	}

	const verifiedBeaconLinkByPeer = (
		role: LinkRole,
		beaconPeerId: string,
		except: RoomLink | null = null,
	) => {
		// One verified beacon link per beacon peer is enough.
		for (const link of room.links.values()) {
			if (link === except) continue
			if (link.role !== role) continue
			if (!isBeaconLink(link)) continue
			if (link.beaconPeerId !== beaconPeerId) continue
			if (isVerifiedLink(link)) return link
		}

		return null
	}

	const setHostAutoStatus = (status: BeaconStatus) => {
		// Beacon status is only visible on the host invite link pane.
		if (room.state.connection.side !== 'host') return

		room.setState('connection', {
			...room.state.connection,
			inviteLinkStatus: status,
		})
	}

	const inviteLinkNextStep = (
		role: 'guest' | 'host',
		presence: BeaconPresence,
	) => {
		if (role === 'host') {
			return presence.guests > 0
				? 'send-offer-to-guest'
				: 'wait-for-guest-or-share-code'
		}

		return presence.hosts > 0 ? 'open-direct-connection' : 'wait-or-claim-link'
	}

	const setGuestInviteLinkPresence = (presence: BeaconPresence) => {
		// Presence turns "waiting" into either connecting or claimable.
		const connection = findingLinkConnection()
		if (connection == null) {
			relayFallback.stop()
			return
		}

		room.setState('connection', {
			...connection,
			issue: null,
			inviteLinkPresence: presence,
		})
		if (presence.hosts > 0) {
			relayFallback.start()
		} else {
			relayFallback.hide()
		}
	}

	const usesGuestRendezvous = () => {
		// Invite-link guests start identity-less, then become normal guests on welcome.
		return room.localParticipantId == null || room.isSelfGuest()
	}

	const beaconRendezvousRole = (): LinkRole | null => {
		// The beacon path mirrors the manual host/guest doorway.
		if (room.isSelfHost()) return 'host-rendezvous'
		if (usesGuestRendezvous()) return 'guest-rendezvous'

		return null
	}

	const createBeaconOffer = async (
		offerId: string,
		beaconPeerId: string | null,
	) => {
		// Beacon offers are speculative; they may never become room members.
		const role = beaconRendezvousRole()
		if (role == null) return null

		const link = createBeaconCandidate(role, { beaconPeerId, offerId })
		if (link == null) return null

		try {
			const offer = await link.peer.createOffer()
			if (room.beaconOffers.get(offerId) !== link) {
				room.closeLink(link)
				return null
			}

			return offer
		} catch (error) {
			log('warn', 'room', 'beacon.offer.create.failed', {
				error,
				link,
				offerId,
			})
			room.closeLink(link)
			return null
		}
	}

	const acceptBeaconAnswer = (
		offerId: string,
		beaconPeerId: string,
		answer: AnswerDescription,
	) => {
		// An answer names the beacon peer that responded to our speculative offer.
		const link = room.beaconOffers.get(offerId)
		if (link == null) {
			log('warn', 'room', 'beacon.answer.missing-offer', { offerId })
			return
		}

		const existing = verifiedBeaconLinkByPeer(link.role, beaconPeerId, link)
		if (existing != null) {
			log('info', 'room', 'beacon.answer.ignored.verified-peer', {
				existing,
				link,
			})
			room.closeLink(link)
			return
		}

		link.beaconPeerId = beaconPeerId
		room.notifyLinksChanged()
		log('info', 'room', 'beacon.answer.accept.start', { link })
		void link.peer
			.acceptAnswer(answer)
			.then(() => {
				if (room.links.get(link.id) !== link) return

				log('info', 'room', 'beacon.answer.accept.done', { link })
			})
			.catch((error) => {
				log('warn', 'room', 'beacon.answer.accept.failed', {
					error,
					link,
					offerId,
				})
				room.closeLink(link)
			})
	}

	const answerBeaconOffer = (
		offer: OfferDescription,
		beaconPeerId: string,
		reply: (answer: AnswerDescription) => void,
	) => {
		// A beacon offer is worth answering only while we know this room secret.
		const role = beaconRendezvousRole()
		if (room.roomKeys == null || role == null) {
			log('warn', 'room', 'beacon.offer.unexpected', {
				hasRoomKeys: room.roomKeys != null,
				role,
			})
			return
		}
		const existing = verifiedBeaconLinkByPeer(role, beaconPeerId)
		if (existing != null) {
			log('info', 'room', 'beacon.offer.ignored.verified-peer', {
				existing,
				role,
			})
			return
		}

		const link = createBeaconCandidate(role, { beaconPeerId })
		if (link == null) return

		void link.peer
			.createAnswer(offer)
			.then((answer) => {
				if (room.links.get(link.id) !== link) return

				log('info', 'room', 'beacon.offer.answer.sent', { link })
				reply(answer)
			})
			.catch((error) => {
				log('warn', 'room', 'beacon.offer.answer.failed', {
					error,
					link,
				})
				room.closeLink(link)
			})
	}

	const startBeaconRendezvous = async (
		secret: RoomSecret,
		role: 'guest' | 'host',
		version: number,
	) => {
		// The invite link becomes discovery plus auth; beacons never see room contents.
		relayFallback.stop()
		const attemptCurrent = () => {
			return (
				room.isCurrentSignalingVersion(version) && room.roomSecret === secret
			)
		}
		try {
			const keys = await deriveRoomKeys(secret)
			if (!attemptCurrent()) return

			room.roomKeys = keys
			room.beaconRendezvous?.close()
			if (role === 'host') {
				for (const link of new Set(room.beaconOffers.values())) {
					room.closeLink(link)
				}
				room.beaconOffers.clear()
			}

			const onPresence = (presence: BeaconPresence) => {
				if (!attemptCurrent()) return

				log('info', 'room', 'invite.link.ready', {
					guests: presence.guests,
					hosts: presence.hosts,
					nextStep: inviteLinkNextStep(role, presence),
					role,
				})
				if (role === 'guest') setGuestInviteLinkPresence(presence)
			}
			const onStatus = (status: BeaconStatus) => {
				if (!attemptCurrent()) return

				if (role === 'host') {
					setHostAutoStatus(status === 'idle' ? 'finding' : status)
					if (status === 'failed') {
						log('warn', 'room', 'invite.link.unreachable', {
							nextStep: 'switch-to-code',
							role,
						})
					}
				} else if (status === 'failed' && findingLinkConnection() != null) {
					log('warn', 'room', 'invite.link.unreachable', {
						nextStep: 'ask-for-code-or-wait',
						role,
					})
					room.setState('connection', {
						...room.state.connection,
						issue: statusCopy.inviteLinkUnreachable,
					})
				}
			}
			const commonOptions = {
				discoveryId: keys.discoveryId,
				onPresence,
				onStatus,
			}
			room.beaconRendezvous =
				role === 'host'
					? createBeaconRendezvous({
							...commonOptions,
							createOffer: createBeaconOffer,
							onAnswer: acceptBeaconAnswer,
							role,
						})
					: createBeaconRendezvous({
							...commonOptions,
							onOffer: answerBeaconOffer,
							role,
						})
		} catch (error) {
			if (!attemptCurrent()) return

			log('warn', 'room', 'beacon.start.failed', { error, role })
			log('warn', 'room', 'invite.link.unreachable', {
				nextStep: role === 'host' ? 'switch-to-code' : 'ask-for-code-or-wait',
				role,
			})
			if (role === 'host') setHostAutoStatus('failed')
			else if (room.state.connection.side === 'guest') {
				room.setState('connection', {
					...room.state.connection,
					issue: statusCopy.inviteLinkUnreachable,
				})
			}
		}
	}

	return { promoteRendezvousLink, startBeaconRendezvous }
}
