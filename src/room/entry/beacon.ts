import type { BeaconPeerId, ExchangeId } from '../../../contracts/beacon'
import type {
	AnswerDescription,
	OfferDescription,
} from '../../../contracts/signal'
import { log } from '../../log'
import type { ParticipantId } from '../../protocol'
import {
	type BeaconPresence,
	type BeaconStatus,
	createBeaconClient,
} from '../../rendezvous/beacon'
import { deriveRoomKeys } from '../../rendezvous/crypto'
import type { RoomSecret } from '../../rendezvous/secret'
import {
	type AdmissionSide,
	isBeaconAdmissionLink,
	isBeaconCandidate,
	isVerifiedLink,
	type RoomLink,
} from '../link'
import { createRelayFallbackTimer } from '../relay'
import type { RoomSession } from '../session'
import { guestFindingLinkEntry } from './state'

const BEACON_CANDIDATE_LIMIT = 12
const BEACON_CANDIDATE_TTL_MS = 45_000

/** Invite-link discovery and secret proof candidates. */
export type BeaconFlow = {
	promoteAdmissionLink: (
		link: RoomLink,
		participantId: ParticipantId,
	) => boolean
	startBeaconClient: (
		secret: RoomSecret,
		role: 'guest' | 'host',
		version: number,
	) => Promise<void>
}

export const createBeaconFlow = (room: RoomSession): BeaconFlow => {
	const findingLinkEntry = () => guestFindingLinkEntry(room.ui.state.entry)

	const setGuestRelayFallbackSeconds = (seconds: number | null) => {
		const entry = findingLinkEntry()
		if (entry == null) return

		room.ui.setState('entry', {
			...entry,
			relayFallbackSecondsLeft: seconds,
		})
	}

	const relayFallback = createRelayFallbackTimer({
		active: room.relay.active,
		currentSecondsLeft: () =>
			findingLinkEntry()?.relayFallbackSecondsLeft ?? null,
		finding: () => findingLinkEntry() != null,
		setSecondsLeft: setGuestRelayFallbackSeconds,
	})

	const beaconCandidates = (side: AdmissionSide) => {
		// Candidate order is insertion order; oldest loses when the budget is full.
		return [...room.links.records.values()].filter((link) =>
			isBeaconCandidate(link, side),
		)
	}

	const candidateBudgetAllows = (side: AdmissionSide) => {
		return beaconCandidates(side).length < BEACON_CANDIDATE_LIMIT
	}

	const expireBeaconCandidate = (link: RoomLink, reason: string) => {
		// Dead candidates should disappear quietly from the portrait projection.
		if (room.links.records.get(link.id) !== link) return
		if (!isBeaconCandidate(link)) return

		log('info', 'room', 'beacon.candidate.expired', {
			link,
			reason,
		})
		room.links.close(link)
	}

	const pruneBeaconCandidateBudget = (side: AdmissionSide) => {
		while (!candidateBudgetAllows(side)) {
			const oldest = beaconCandidates(side)[0]
			if (oldest == null) return

			expireBeaconCandidate(oldest, 'budget')
		}
	}

	const createBeaconCandidate = (
		side: AdmissionSide,
		options: {
			peerId?: BeaconPeerId | null
			exchangeId?: ExchangeId | null
		} = {},
	) => {
		// Beacon offers are speculative. Keep only a small bench of hopeful links.
		pruneBeaconCandidateBudget(side)
		if (!candidateBudgetAllows(side)) {
			log('warn', 'room', 'beacon.candidate.budget-full', { side })
			return null
		}

		const link = room.links.create({
			auth: 'pending',
			kind: 'admission',
			peerId: options.peerId ?? null,
			side,
			via: 'beacon',
		})
		if (options.exchangeId != null) {
			room.links.exchanges.set(options.exchangeId, link)
		}

		setTimeout(() => {
			expireBeaconCandidate(link, 'timeout')
		}, BEACON_CANDIDATE_TTL_MS)
		return link
	}

	const promoteAdmissionLink = (
		link: RoomLink,
		participantId: ParticipantId,
	) => {
		// Beacon discovery earns a room seat only after auth proves the secret.
		if (isBeaconAdmissionLink(link) && !isVerifiedLink(link)) {
			log('warn', 'room', 'beacon.candidate.promote.before-auth', {
				link,
				participantId,
			})
			room.links.close(link)
			return false
		}

		// Admission purpose carries the path needed to retire sibling candidates.
		room.links.closeSiblingAdmissions(link)
		if (!room.links.adopt(link, participantId)) return false
		return true
	}

	const verifiedBeaconLinkByPeer = (
		side: AdmissionSide,
		peerId: BeaconPeerId,
		except: RoomLink | null = null,
	) => {
		// One verified beacon link per beacon peer is enough.
		for (const link of room.links.records.values()) {
			if (link === except) continue
			if (!isBeaconAdmissionLink(link)) continue
			if (link.purpose.side !== side) continue
			if (link.purpose.peerId !== peerId) continue
			if (isVerifiedLink(link)) return link
		}

		return null
	}

	const setHostAutoStatus = (status: BeaconStatus) => {
		// Beacon status is only visible on the host invite link pane.
		if (room.ui.state.entry.side !== 'host') return

		room.ui.setState('entry', {
			...room.ui.state.entry,
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
		const entry = findingLinkEntry()
		if (entry == null) {
			relayFallback.stop()
			return
		}

		room.ui.setState('entry', {
			...entry,
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
		return room.session.selfId == null || room.session.isGuest()
	}

	const beaconAdmissionSide = (): AdmissionSide | null => {
		// The beacon path mirrors the manual host/guest doorway.
		if (room.session.isHost()) return 'host'
		if (usesGuestRendezvous()) return 'guest'

		return null
	}

	const createBeaconOffer = async (
		exchangeId: ExchangeId,
		to: BeaconPeerId | null,
	) => {
		// Beacon offers are speculative; they may never become room members.
		const side = beaconAdmissionSide()
		if (side == null) return null

		const link = createBeaconCandidate(side, {
			peerId: to,
			exchangeId,
		})
		if (link == null) return null

		try {
			const offer = await link.rtc.createOffer()
			if (room.links.exchanges.get(exchangeId) !== link) {
				room.links.close(link)
				return null
			}

			return offer
		} catch (error) {
			log('warn', 'room', 'beacon.offer.create.failed', {
				error,
				link,
				exchangeId,
			})
			room.links.close(link)
			return null
		}
	}

	const acceptBeaconAnswer = (
		exchangeId: ExchangeId,
		from: BeaconPeerId,
		answer: AnswerDescription,
	) => {
		// An answer names the beacon peer that responded to our speculative offer.
		const link = room.links.exchanges.get(exchangeId)
		if (link == null) {
			log('warn', 'room', 'beacon.answer.missing-offer', { exchangeId })
			return
		}

		if (!isBeaconAdmissionLink(link)) return
		const existing = verifiedBeaconLinkByPeer(link.purpose.side, from, link)
		if (existing != null) {
			log('info', 'room', 'beacon.answer.ignored.verified-peer', {
				existing,
				link,
			})
			room.links.close(link)
			return
		}

		link.purpose.peerId = from
		room.links.notifyChanged()
		log('info', 'room', 'beacon.answer.accept.start', { link })
		void link.rtc
			.acceptAnswer(answer)
			.then(() => {
				if (room.links.records.get(link.id) !== link) return

				log('info', 'room', 'beacon.answer.accept.done', { link })
			})
			.catch((error) => {
				log('warn', 'room', 'beacon.answer.accept.failed', {
					error,
					link,
					exchangeId,
				})
				room.links.close(link)
			})
	}

	const answerBeaconOffer = (
		offer: OfferDescription,
		from: BeaconPeerId,
		reply: (answer: AnswerDescription) => void,
	) => {
		// A beacon offer is worth answering only while we know this room secret.
		const side = beaconAdmissionSide()
		if (room.session.keys == null || side == null) {
			log('warn', 'room', 'beacon.offer.unexpected', {
				hasRoomKeys: room.session.keys != null,
				side,
			})
			return
		}
		const existing = verifiedBeaconLinkByPeer(side, from)
		if (existing != null) {
			log('info', 'room', 'beacon.offer.ignored.verified-peer', {
				existing,
				side,
			})
			return
		}

		const link = createBeaconCandidate(side, { peerId: from })
		if (link == null) return

		void link.rtc
			.createAnswer(offer)
			.then((answer) => {
				if (room.links.records.get(link.id) !== link) return

				log('info', 'room', 'beacon.offer.answer.sent', { link })
				reply(answer)
			})
			.catch((error) => {
				log('warn', 'room', 'beacon.offer.answer.failed', {
					error,
					link,
				})
				room.links.close(link)
			})
	}

	const startBeaconClient = async (
		secret: RoomSecret,
		role: 'guest' | 'host',
		version: number,
	) => {
		// The invite link becomes discovery plus auth; beacons never see room contents.
		relayFallback.stop()
		const attemptCurrent = () => {
			return (
				room.session.isCurrentSignalingGeneration(version) &&
				room.session.inviteSecret === secret
			)
		}
		try {
			const keys = await deriveRoomKeys(secret)
			if (!attemptCurrent()) return

			room.session.keys = keys
			room.session.beaconClient?.close()
			if (role === 'host') {
				for (const link of new Set(room.links.exchanges.values())) {
					room.links.close(link)
				}
				room.links.exchanges.clear()
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
				} else if (status === 'failed' && findingLinkEntry() != null) {
					log('warn', 'room', 'invite.link.unreachable', {
						nextStep: 'ask-for-code-or-wait',
						role,
					})
					room.ui.setState('entry', {
						...room.ui.state.entry,
						issue: 'discovery-unreachable',
					})
				}
			}
			const commonOptions = {
				discoveryId: keys.discoveryId,
				onPresence,
				onStatus,
			}
			room.session.beaconClient =
				role === 'host'
					? createBeaconClient({
							...commonOptions,
							createOffer: createBeaconOffer,
							onAnswer: acceptBeaconAnswer,
							role,
						})
					: createBeaconClient({
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
			else if (room.ui.state.entry.side === 'guest') {
				room.ui.setState('entry', {
					...room.ui.state.entry,
					issue: 'discovery-unreachable',
				})
			}
		}
	}

	return { promoteAdmissionLink, startBeaconClient }
}
