import type {
	AnswerDescription,
	OfferDescription,
} from '../../contracts/signal'
import { log } from '../log'
import type { Packet, ParticipantId, RoomMembership } from '../protocol'
import { newSignalExchangeId } from '../random'
import type { RoomConnection } from './link'

type MeshSignalPacket = Extract<Packet, { type: 'peer-signal' }>

const MESH_NEGOTIATION_TIMEOUT_MS = 20_000
const MESH_RETRY_DELAY_MS = 2_000

/** Guest-to-guest connection setup relayed through the host. */
export const createRoomMesh = (options: {
	closeConnection: (connection: RoomConnection) => void
	connectionFor: (participantId: ParticipantId) => RoomConnection | null
	createConnection: (
		participantId: ParticipantId,
		exchangeId: MeshSignalPacket['exchangeId'],
	) => RoomConnection | null
	membership: () => RoomMembership | null
	roster: () => ParticipantId[]
	sendToHost: (message: Packet) => boolean
}) => {
	const retries = new Map<
		ParticipantId,
		{ connection: RoomConnection; timer: ReturnType<typeof setTimeout> }
	>()

	const scheduleOfferRetry = (
		participantId: ParticipantId,
		connection: RoomConnection,
		delayMs: number,
		membership: RoomMembership,
	) => {
		const scheduled = retries.get(participantId)
		if (scheduled?.connection === connection) clearTimeout(scheduled.timer)

		const timer = setTimeout(() => {
			if (retries.get(participantId)?.timer !== timer) return
			retries.delete(participantId)
			if (options.membership() !== membership) return

			const current = options.connectionFor(participantId)
			if (current === connection && !connection.connected) {
				options.closeConnection(connection)
			}
			if (
				membership.selfId !== membership.hostId &&
				options.roster().includes(participantId) &&
				options.connectionFor(participantId) == null
			) {
				void offerConnection(participantId)
			}
		}, delayMs)
		retries.set(participantId, { connection, timer })
	}

	const retryFailedOffer = (
		participantId: ParticipantId,
		connection: RoomConnection,
		membership: RoomMembership,
	) => {
		if (
			options.membership() !== membership ||
			options.connectionFor(participantId) !== connection
		) {
			return false
		}
		options.closeConnection(connection)
		scheduleOfferRetry(
			participantId,
			connection,
			MESH_RETRY_DELAY_MS,
			membership,
		)
		return true
	}

	const offerConnection = async (participantId: ParticipantId) => {
		const membership = options.membership()
		const scheduled = retries.get(participantId)
		if (scheduled != null) {
			if (options.connectionFor(participantId) === scheduled.connection) return
			clearTimeout(scheduled.timer)
			retries.delete(participantId)
		}
		if (
			membership == null ||
			membership.selfId === membership.hostId ||
			membership.selfId < participantId ||
			!options.roster().includes(participantId) ||
			options.connectionFor(participantId) != null
		) {
			return
		}

		const exchangeId = newSignalExchangeId()
		const connection = options.createConnection(participantId, exchangeId)
		if (connection == null) return
		scheduleOfferRetry(
			participantId,
			connection,
			MESH_NEGOTIATION_TIMEOUT_MS,
			membership,
		)

		try {
			const signal = await connection.rtc.createOffer()
			if (options.connectionFor(participantId) !== connection) {
				return
			}

			if (
				!options.sendToHost({
					exchangeId,
					type: 'peer-signal',
					from: membership.selfId,
					to: participantId,
					signal,
				})
			) {
				if (retryFailedOffer(participantId, connection, membership)) {
					log('warn', 'room', 'mesh.offer.send.failed', {
						participantId,
					})
				}
			}
		} catch (error) {
			if (retryFailedOffer(participantId, connection, membership)) {
				log('warn', 'room', 'mesh.offer.failed', {
					error,
					participantId,
				})
			}
		}
	}

	const connectMissingPeers = () => {
		// The lexicographically larger guest offers, so every pair creates one edge.
		const membership = options.membership()
		if (membership == null || membership.selfId === membership.hostId) {
			return
		}

		for (const participantId of options.roster()) {
			if (
				participantId === membership.selfId ||
				participantId === membership.hostId ||
				options.connectionFor(participantId) != null ||
				membership.selfId < participantId
			) {
				continue
			}

			void offerConnection(participantId)
		}
	}

	const acceptOffer = async (
		message: MeshSignalPacket,
		signal: OfferDescription,
	) => {
		// The target guest answers, then the host carries that answer back.
		const membership = options.membership()
		if (membership == null || membership.selfId === membership.hostId) {
			return
		}
		if (message.to !== membership.selfId) {
			log('warn', 'room', 'mesh.offer.wrong-target', {
				from: message.from,
				to: message.to,
			})
			return
		}
		if (message.from < membership.selfId) {
			log('warn', 'room', 'mesh.offer.wrong-dialer', {
				from: message.from,
				to: membership.selfId,
			})
			return
		}

		// Keep a live edge, but replace a negotiation that never opened.
		const existing = options.connectionFor(message.from)
		if (existing?.connected) return
		if (
			existing?.origin.kind === 'mesh' &&
			existing.origin.exchangeId === message.exchangeId
		) {
			return
		}
		if (existing != null) options.closeConnection(existing)

		const connection = options.createConnection(
			message.from,
			message.exchangeId,
		)
		if (connection == null) return

		try {
			const answer = await connection.rtc.createAnswer(signal)
			if (options.connectionFor(message.from) !== connection) {
				options.closeConnection(connection)
				return
			}

			if (
				!options.sendToHost({
					exchangeId: message.exchangeId,
					type: 'peer-signal',
					from: membership.selfId,
					to: message.from,
					signal: answer,
				})
			) {
				log('warn', 'room', 'mesh.answer.send.failed', {
					participantId: message.from,
				})
				options.closeConnection(connection)
			}
		} catch (error) {
			log('warn', 'room', 'mesh.answer.failed', {
				error,
				participantId: message.from,
			})
			options.closeConnection(connection)
		}
	}

	const acceptAnswer = async (
		message: MeshSignalPacket,
		signal: AnswerDescription,
	) => {
		// The dialing guest completes the direct edge here.
		const membership = options.membership()
		if (membership == null || membership.selfId === membership.hostId) return
		if (message.to !== membership.selfId) {
			log('warn', 'room', 'mesh.answer.wrong-target', {
				from: message.from,
				to: message.to,
			})
			return
		}
		if (membership.selfId < message.from) {
			log('warn', 'room', 'mesh.answer.wrong-dialer', {
				from: message.from,
				to: membership.selfId,
			})
			return
		}

		const connection = options.connectionFor(message.from)
		if (connection == null) {
			log('warn', 'room', 'mesh.answer.missing-link', {
				from: message.from,
			})
			return
		}
		if (connection.connected) return
		if (
			connection.origin.kind !== 'mesh' ||
			connection.origin.exchangeId !== message.exchangeId
		) {
			log('warn', 'room', 'mesh.answer.stale-exchange', {
				expected:
					connection.origin.kind === 'mesh'
						? connection.origin.exchangeId
						: null,
				from: message.from,
				received: message.exchangeId,
			})
			return
		}
		// Consume before awaiting RTC so a replay cannot race this answer.
		connection.origin.exchangeId = null

		try {
			await connection.rtc.acceptAnswer(signal)
		} catch (error) {
			if (retryFailedOffer(message.from, connection, membership)) {
				log('warn', 'room', 'mesh.answer.accept.failed', {
					error,
					from: message.from,
				})
			}
		}
	}

	const handleSignal = (message: MeshSignalPacket) => {
		return message.signal.type === 'offer'
			? acceptOffer(message, message.signal)
			: acceptAnswer(message, message.signal)
	}

	/** Cancel negotiations so no old room can retry inside its successor. */
	const reset = () => {
		for (const retry of retries.values()) clearTimeout(retry.timer)
		retries.clear()
	}

	return { connectMissingPeers, handleSignal, reset }
}
