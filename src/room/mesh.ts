import type {
	AnswerDescription,
	OfferDescription,
} from '../../contracts/signal'
import { log } from '../log'
import type { Packet, ParticipantId } from '../protocol'
import type { RoomLink } from './link'

type MeshSignalPacket = Extract<Packet, { type: 'peer-signal' }>

/** Guest-to-guest mesh signaling carried through the host rendezvous link. */
export type RoomMesh = {
	acceptSignal: (message: MeshSignalPacket) => Promise<void>
	startMissingOffers: () => void
}

/** Mesh setup controller; the room keeps ownership of identities and links. */
export const createRoomMesh = (options: {
	closeLink: (link: RoomLink) => void
	createMeshLink: (participantId: ParticipantId) => RoomLink | null
	hostParticipantId: () => ParticipantId | null
	isSelfGuest: () => boolean
	linkByParticipantId: (participantId: ParticipantId) => RoomLink | null
	localParticipantId: () => ParticipantId | null
	participantIds: () => ParticipantId[]
	participantLink: (participantId: ParticipantId) => RoomLink | null
	sendToHost: (message: Packet) => boolean
}): RoomMesh => {
	// The host shares rosters and forwards offers/answers; guests deterministically dial each edge once.
	const createOffer = async (participantId: ParticipantId) => {
		const localParticipantId = options.localParticipantId()
		const hostParticipantId = options.hostParticipantId()
		if (
			!options.isSelfGuest() ||
			localParticipantId == null ||
			hostParticipantId == null ||
			options.participantLink(participantId) != null
		) {
			return
		}

		const link = options.createMeshLink(participantId)
		if (link == null) return

		try {
			const signal = await link.rtc.createOffer()
			if (options.participantLink(participantId) !== link) {
				options.closeLink(link)
				return
			}

			if (
				!options.sendToHost({
					type: 'peer-signal',
					from: localParticipantId,
					to: participantId,
					signal,
				})
			) {
				log('warn', 'room', 'mesh.offer.send.failed', {
					participantId,
				})
				options.closeLink(link)
			}
		} catch (error) {
			log('warn', 'room', 'mesh.offer.failed', {
				error,
				participantId,
			})
			options.closeLink(link)
		}
	}

	const startMissingOffers = () => {
		// After each roster update, fill in direct guest-to-guest edges.
		const localParticipantId = options.localParticipantId()
		const hostParticipantId = options.hostParticipantId()
		if (
			!options.isSelfGuest() ||
			localParticipantId == null ||
			hostParticipantId == null
		) {
			return
		}

		for (const participantId of options.participantIds()) {
			if (
				participantId === localParticipantId ||
				participantId === hostParticipantId ||
				options.linkByParticipantId(participantId) != null ||
				localParticipantId < participantId
			) {
				continue
			}

			void createOffer(participantId)
		}
	}

	const acceptOffer = async (
		message: MeshSignalPacket,
		signal: OfferDescription,
	) => {
		// The target guest answers, then the host carries that answer back.
		const localParticipantId = options.localParticipantId()
		if (!options.isSelfGuest() || localParticipantId == null) {
			return
		}
		if (message.to !== localParticipantId) {
			log('warn', 'room', 'mesh.offer.wrong-target', {
				from: message.from,
				to: message.to,
			})
			return
		}

		const existing = options.participantLink(message.from)
		if (existing != null) options.closeLink(existing)

		const link = options.createMeshLink(message.from)
		if (link == null) return

		try {
			const answer = await link.rtc.createAnswer(signal)
			if (options.participantLink(message.from) !== link) {
				options.closeLink(link)
				return
			}

			if (
				!options.sendToHost({
					type: 'peer-signal',
					from: localParticipantId,
					to: message.from,
					signal: answer,
				})
			) {
				log('warn', 'room', 'mesh.answer.send.failed', {
					participantId: message.from,
				})
				options.closeLink(link)
			}
		} catch (error) {
			log('warn', 'room', 'mesh.answer.failed', {
				error,
				participantId: message.from,
			})
			options.closeLink(link)
		}
	}

	const acceptAnswer = async (
		message: MeshSignalPacket,
		signal: AnswerDescription,
	) => {
		// The dialing guest completes the direct edge here.
		const localParticipantId = options.localParticipantId()
		if (localParticipantId == null) return
		if (message.to !== localParticipantId) {
			log('warn', 'room', 'mesh.answer.wrong-target', {
				from: message.from,
				to: message.to,
			})
			return
		}

		const link = options.participantLink(message.from)
		if (link == null) {
			log('warn', 'room', 'mesh.answer.missing-link', {
				from: message.from,
			})
			return
		}

		try {
			await link.rtc.acceptAnswer(signal)
		} catch (error) {
			log('warn', 'room', 'mesh.answer.accept.failed', {
				error,
				from: message.from,
			})
			options.closeLink(link)
		}
	}

	const acceptSignal = (message: MeshSignalPacket) => {
		return message.signal.type === 'offer'
			? acceptOffer(message, message.signal)
			: acceptAnswer(message, message.signal)
	}

	return { acceptSignal, startMissingOffers }
}
