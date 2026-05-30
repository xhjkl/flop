import { log } from '../log'
import {
	type Packet,
	type ParticipantId,
	participantIdToString,
} from '../protocol'
import type { RoomLink } from './link'
import type { ParticipantKey, RoomParticipant } from './participant'

type MeshOfferPacket = Extract<Packet, { type: 'peer-offer' }>
type MeshAnswerPacket = Extract<Packet, { type: 'peer-answer' }>

/** Guest-to-guest mesh signaling carried through the host rendezvous link. */
export type RoomMesh = {
	acceptAnswer: (message: MeshAnswerPacket) => Promise<void>
	acceptOffer: (message: MeshOfferPacket) => Promise<void>
	startMissingOffers: () => void
}

/** Mesh setup controller; the room keeps ownership of identities and links. */
export const createRoomMesh = (options: {
	closeLink: (link: RoomLink) => void
	createMeshLink: (participantId: ParticipantId) => RoomLink | null
	hostParticipantId: () => ParticipantId | null
	isSelfGuest: () => boolean
	linkByParticipantKey: (key: ParticipantKey) => RoomLink | null
	localParticipantId: () => ParticipantId | null
	participantByKey: (key: ParticipantKey) => RoomParticipant | null
	participantKeys: () => ParticipantKey[]
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
			const signal = await link.peer.createOffer()
			if (options.participantLink(participantId) !== link) {
				options.closeLink(link)
				return
			}

			if (
				!options.sendToHost({
					type: 'peer-offer',
					from: localParticipantId,
					to: participantId,
					signal,
				})
			) {
				log('warn', 'room', 'mesh.offer.send.failed', {
					participantId: participantIdToString(participantId),
				})
				options.closeLink(link)
			}
		} catch (error) {
			log('warn', 'room', 'mesh.offer.failed', {
				error,
				participantId: participantIdToString(participantId),
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

		for (const key of options.participantKeys()) {
			const participant = options.participantByKey(key)
			if (participant == null) continue

			if (
				participant.participantId === localParticipantId ||
				participant.participantId === hostParticipantId ||
				options.linkByParticipantKey(key) != null ||
				localParticipantId < participant.participantId
			) {
				continue
			}

			void createOffer(participant.participantId)
		}
	}

	const acceptOffer = async (message: MeshOfferPacket) => {
		// The target guest answers, then the host carries that answer back.
		const localParticipantId = options.localParticipantId()
		if (!options.isSelfGuest() || localParticipantId == null) {
			return
		}
		if (message.to !== localParticipantId) {
			log('warn', 'room', 'mesh.offer.wrong-target', {
				from: participantIdToString(message.from),
				to: participantIdToString(message.to),
			})
			return
		}

		const existing = options.participantLink(message.from)
		if (existing != null) options.closeLink(existing)

		const link = options.createMeshLink(message.from)
		if (link == null) return

		try {
			const signal = await link.peer.createAnswer(message.signal)
			if (options.participantLink(message.from) !== link) {
				options.closeLink(link)
				return
			}

			if (
				!options.sendToHost({
					type: 'peer-answer',
					from: localParticipantId,
					to: message.from,
					signal,
				})
			) {
				log('warn', 'room', 'mesh.answer.send.failed', {
					participantId: participantIdToString(message.from),
				})
				options.closeLink(link)
			}
		} catch (error) {
			log('warn', 'room', 'mesh.answer.failed', {
				error,
				participantId: participantIdToString(message.from),
			})
			options.closeLink(link)
		}
	}

	const acceptAnswer = async (message: MeshAnswerPacket) => {
		// The dialing guest completes the direct edge here.
		const localParticipantId = options.localParticipantId()
		if (localParticipantId == null) return
		if (message.to !== localParticipantId) {
			log('warn', 'room', 'mesh.answer.wrong-target', {
				from: participantIdToString(message.from),
				to: participantIdToString(message.to),
			})
			return
		}

		const link = options.participantLink(message.from)
		if (link == null) {
			log('warn', 'room', 'mesh.answer.missing-link', {
				from: participantIdToString(message.from),
			})
			return
		}

		try {
			await link.peer.acceptAnswer(message.signal)
		} catch (error) {
			log('warn', 'room', 'mesh.answer.accept.failed', {
				error,
				from: participantIdToString(message.from),
			})
			options.closeLink(link)
		}
	}

	return { acceptAnswer, acceptOffer, startMissingOffers }
}
