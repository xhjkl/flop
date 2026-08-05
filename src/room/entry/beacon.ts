import type { BeaconPeer, BeaconPeerId } from '../../../contracts/beacon'
import type {
	AnswerDescription,
	OfferDescription,
	SignalExchangeId,
} from '../../../contracts/signal'
import { log } from '../../log'
import {
	type BeaconSocketStatus,
	createBeaconClient,
} from '../../rendezvous/beacon'
import { deriveRoomKeys } from '../../rendezvous/crypto'
import {
	hasRoomAccess,
	isBeaconConnection,
	type LocalRoomRole,
	type RoomConnection,
} from '../link'
import { RELAY_FALLBACK_WAIT_SECONDS } from '../relay'
import type { RendezvousAttempt, RoomSession } from '../session'
import { asHostDiscovery } from './state'

const BEACON_CANDIDATE_LIMIT = 12
const BEACON_CANDIDATE_TTL_MS = 45_000

/** Invite-link discovery and pre-membership candidates authenticated by its secret. */
export const createBeaconFlow = (room: RoomSession) => {
	const candidateTimeouts = new WeakMap<RoomConnection, () => void>()
	const hostDiscovery = () => asHostDiscovery(room.state.entry)
	let cancelRelayFallback: (() => void) | null = null
	let relayFallbackEndsAt = 0

	const setGuestRelayFallbackSeconds = (seconds: number | null) => {
		const entry = hostDiscovery()
		if (entry == null) return
		room.setState('entry', {
			...entry,
			relayFallbackSecondsLeft: seconds,
		})
	}

	const stopRelayFallback = () => {
		cancelRelayFallback?.()
		cancelRelayFallback = null
	}

	const hideRelayFallback = () => {
		stopRelayFallback()
		setGuestRelayFallbackSeconds(null)
	}

	const updateRelayFallback = () => {
		if (hostDiscovery() == null) {
			return
		}
		if (room.relay.active()) {
			hideRelayFallback()
			return
		}

		const secondsLeft = Math.max(
			0,
			Math.ceil((relayFallbackEndsAt - Date.now()) / 1000),
		)
		setGuestRelayFallbackSeconds(secondsLeft)
		if (secondsLeft === 0) return

		const attempt = room.rendezvous.current
		if (attempt?.localRole !== 'guest') return
		cancelRelayFallback = attempt.scheduleTimeout(() => {
			cancelRelayFallback = null
			updateRelayFallback()
		}, 1000)
	}

	const startRelayFallback = () => {
		if (room.relay.active() || cancelRelayFallback != null) return
		if (hostDiscovery()?.relayFallbackSecondsLeft === 0) return

		relayFallbackEndsAt = Date.now() + RELAY_FALLBACK_WAIT_SECONDS * 1000
		setGuestRelayFallbackSeconds(RELAY_FALLBACK_WAIT_SECONDS)
		const attempt = room.rendezvous.current
		if (attempt?.localRole !== 'guest') return
		cancelRelayFallback = attempt.scheduleTimeout(() => {
			cancelRelayFallback = null
			updateRelayFallback()
		}, 1000)
	}

	const candidates = (role: LocalRoomRole) => {
		return room.connections.admissions().filter((connection) => {
			return (
				isBeaconConnection(connection) && connection.origin.localRole === role
			)
		})
	}

	const beaconConnection = (
		role: LocalRoomRole,
		peerId: BeaconPeerId,
		except: RoomConnection | null = null,
	) => {
		const assigned = room.peers
			.all()
			.flatMap((peer) => (peer.connection == null ? [] : [peer.connection]))
		return (
			[...room.connections.admissions(), ...assigned].find((connection) => {
				return (
					connection !== except &&
					isBeaconConnection(connection) &&
					connection.origin.localRole === role &&
					connection.origin.peerId === peerId
				)
			}) ?? null
		)
	}

	const forgetTimeout = (connection: RoomConnection) => {
		const cancel = candidateTimeouts.get(connection)
		if (cancel == null) return
		cancel()
		candidateTimeouts.delete(connection)
	}

	const expire = (connection: RoomConnection, reason: 'budget' | 'timeout') => {
		forgetTimeout(connection)
		if (!room.connections.isCurrent(connection)) return
		if (room.connections.peerByConnection(connection) != null) return
		if (!isBeaconConnection(connection)) return

		log('info', 'room', 'beacon.candidate.expired', { connection, reason })
		room.connections.close(connection)
	}

	const createCandidate = (
		attempt: RendezvousAttempt,
		peerId: BeaconPeerId,
		exchangeId: SignalExchangeId | null,
	) => {
		if (!room.rendezvous.isCurrent(attempt)) return null
		const current = candidates(attempt.localRole)
		if (current.length >= BEACON_CANDIDATE_LIMIT) {
			expire(current[0], 'budget')
		}

		const connection = room.connections.createAdmission({
			authenticated: false,
			exchangeId,
			kind: 'beacon',
			peerId,
			localRole: attempt.localRole,
		})
		const cancel = attempt.scheduleTimeout(() => {
			candidateTimeouts.delete(connection)
			expire(connection, 'timeout')
		}, BEACON_CANDIDATE_TTL_MS)
		candidateTimeouts.set(connection, cancel)
		return connection
	}

	const authorizedBeaconConnection = (
		role: LocalRoomRole,
		peerId: BeaconPeerId,
		except: RoomConnection | null = null,
	) => {
		const connection = beaconConnection(role, peerId, except)
		return connection != null && hasRoomAccess(connection) ? connection : null
	}

	const setHostLinkPhase = (status: BeaconSocketStatus) => {
		const entry = room.state.entry
		if (entry.side !== 'host') return
		room.setState('entry', {
			...entry,
			inviteLinkPhase:
				status === 'ready'
					? 'ready'
					: status === 'failed'
						? 'failed'
						: 'preparing',
		})
	}

	const setGuestPeers = (peers: BeaconPeer[]) => {
		const entry = hostDiscovery()
		if (entry == null) {
			stopRelayFallback()
			return
		}

		const hostPresent = peers.some((peer) => peer.role === 'host')
		room.setState('entry', {
			...entry,
			hostPresent,
			issue: null,
		})
		if (hostPresent) startRelayFallback()
		else hideRelayFallback()
	}

	const createOffer = async (
		attempt: RendezvousAttempt,
		exchangeId: SignalExchangeId,
		to: BeaconPeerId,
	) => {
		if (beaconConnection(attempt.localRole, to) != null) return null
		const connection = createCandidate(attempt, to, exchangeId)
		if (connection == null) return null

		try {
			const offer = await connection.rtc.createOffer()
			if (
				!room.rendezvous.isCurrent(attempt) ||
				!room.connections.isCurrent(connection)
			) {
				room.connections.close(connection)
				return null
			}
			return offer
		} catch (error) {
			log('warn', 'room', 'beacon.offer.create.failed', {
				connection,
				error,
				exchangeId,
			})
			room.connections.close(connection)
			return null
		}
	}

	const acceptAnswer = (
		attempt: RendezvousAttempt,
		exchangeId: SignalExchangeId,
		from: BeaconPeerId,
		answer: AnswerDescription,
	) => {
		const connection = candidates(attempt.localRole).find(
			(candidate) =>
				isBeaconConnection(candidate) &&
				candidate.origin.exchangeId === exchangeId,
		)
		if (connection == null || !isBeaconConnection(connection)) {
			log('warn', 'room', 'beacon.answer.missing-offer', { exchangeId })
			return
		}
		if (
			connection.origin.peerId !== from ||
			connection.origin.localRole !== attempt.localRole
		) {
			log('warn', 'room', 'beacon.answer.wrong-peer', {
				connection,
				from,
			})
			room.connections.close(connection)
			return
		}
		if (
			authorizedBeaconConnection(attempt.localRole, from, connection) != null
		) {
			room.connections.close(connection)
			return
		}

		// A targeted exchange has exactly one answer; consume it before awaiting RTC.
		connection.origin.exchangeId = null
		void connection.rtc.acceptAnswer(answer).catch((error) => {
			log('warn', 'room', 'beacon.answer.accept.failed', {
				connection,
				error,
				exchangeId,
			})
			room.connections.close(connection)
		})
	}

	const answerOffer = (
		attempt: RendezvousAttempt,
		offer: OfferDescription,
		from: BeaconPeerId,
		reply: (answer: AnswerDescription) => void,
	) => {
		if (attempt.keys == null || !room.rendezvous.isCurrent(attempt)) return
		if (authorizedBeaconConnection(attempt.localRole, from) != null) return
		const connection = createCandidate(attempt, from, null)
		if (connection == null) return

		void connection.rtc
			.createAnswer(offer)
			.then((answer) => {
				if (!room.connections.isCurrent(connection)) return
				reply(answer)
			})
			.catch((error) => {
				log('warn', 'room', 'beacon.offer.answer.failed', {
					connection,
					error,
				})
				room.connections.close(connection)
			})
	}

	const start = async (attempt: RendezvousAttempt) => {
		stopRelayFallback()
		if (attempt.secret == null) return
		try {
			const keys = await deriveRoomKeys(attempt.secret)
			if (!room.rendezvous.isCurrent(attempt)) return
			attempt.keys = keys
			attempt.client?.close()

			const onStatus = (status: BeaconSocketStatus) => {
				if (!room.rendezvous.isCurrent(attempt)) return
				if (attempt.localRole === 'host') {
					setHostLinkPhase(status)
					return
				}
				if (status !== 'failed') return
				const entry = hostDiscovery()
				if (entry == null) return
				room.setState('entry', {
					...entry,
					issue: 'discovery-unreachable',
				})
			}

			const common = {
				discoveryId: keys.discoveryId,
				onPeers: (peers: BeaconPeer[]) => {
					if (!room.rendezvous.isCurrent(attempt)) return
					if (attempt.localRole === 'guest') setGuestPeers(peers)
				},
				onStatus,
			}
			attempt.client =
				attempt.localRole === 'host'
					? createBeaconClient({
							...common,
							createOffer: (exchangeId, to) =>
								createOffer(attempt, exchangeId, to),
							onAnswer: (exchangeId, from, answer) =>
								acceptAnswer(attempt, exchangeId, from, answer),
							role: 'host',
						})
					: createBeaconClient({
							...common,
							onOffer: (offer, from, reply) =>
								answerOffer(attempt, offer, from, reply),
							role: 'guest',
						})
		} catch (error) {
			if (!room.rendezvous.isCurrent(attempt)) return
			log('warn', 'room', 'beacon.start.failed', {
				error,
				role: attempt.localRole,
			})
			if (attempt.localRole === 'host') setHostLinkPhase('failed')
			else {
				const entry = hostDiscovery()
				if (entry != null) {
					room.setState('entry', {
						...entry,
						issue: 'discovery-unreachable',
					})
				}
			}
		}
	}

	return { start }
}

export type BeaconFlow = ReturnType<typeof createBeaconFlow>
