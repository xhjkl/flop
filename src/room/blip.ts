import { encodePacket, type Packet, type ParticipantId } from '../protocol'
import type { Peer } from '../webrtc'
import type { RoomLink } from './link'
import type { RoomParticipant } from './participant'

/** Local blip state that can exist before the guest has a room identity. */
export type RoomBlips = {
	applyPending: () => void
	clearPending: () => void
	localBlip: () => string | null
	publishLocal: () => number
	sendLocalToPeer: (peer: Peer) => boolean
	send: (text?: string) => void
}

/** Blip composer actions and replay logic, separated from invite/admission state. */
export const createRoomBlips = (options: {
	getComposerText: () => string
	getLocalParticipantId: () => ParticipantId | null
	liveParticipantLinks: () => RoomLink[]
	participantById: (
		participantId: ParticipantId | null,
	) => RoomParticipant | null
	sendToLinks: (links: RoomLink[], packet: Packet) => number
	setBlipIssue: (issue: string | null) => void
	setComposerText: (text: string) => void
	setParticipantBlip: (participantId: ParticipantId, text: string) => void
}): RoomBlips => {
	// Guests can write a blip before the host gives them a participant id.
	let pendingLocalBlip: string | null = null

	const clearPending = () => {
		pendingLocalBlip = null
	}

	const localBlip = () => {
		return (
			options.participantById(options.getLocalParticipantId())?.activity.blip ??
			pendingLocalBlip
		)
	}

	const applyPending = () => {
		// Welcome gives the pending blip a real owner.
		const localParticipantId = options.getLocalParticipantId()
		if (localParticipantId == null || pendingLocalBlip == null) return

		options.setParticipantBlip(localParticipantId, pendingLocalBlip)
		pendingLocalBlip = null
	}

	const sendLocalToPeer = (peer: Peer) => {
		// New links should see the current blip without waiting for the next edit.
		const blip = localBlip()
		if (blip == null) return false

		return peer.send(encodePacket({ type: 'blip', text: blip }))
	}

	const publishLocal = () => {
		// Replay the current blip to newly welcomed peers; edits send their own packet.
		const blip = localBlip()
		if (blip == null) return 0

		return options.sendToLinks(options.liveParticipantLinks(), {
			type: 'blip',
			text: blip,
		})
	}

	const send = (text = options.getComposerText()) => {
		// Blips are tiny presence, so we store locally and fan out immediately.
		const blip = text.trim()
		const currentBlip = localBlip()
		if (blip === '' && currentBlip == null) return

		const localParticipantId = options.getLocalParticipantId()
		if (localParticipantId == null) {
			pendingLocalBlip = blip === '' ? null : blip
		} else {
			pendingLocalBlip = null
			options.setParticipantBlip(localParticipantId, blip)
		}

		options.sendToLinks(options.liveParticipantLinks(), {
			type: 'blip',
			text: blip,
		})
		options.setComposerText(blip)
		options.setBlipIssue(null)
	}

	return {
		applyPending,
		clearPending,
		localBlip,
		publishLocal,
		sendLocalToPeer,
		send,
	}
}
