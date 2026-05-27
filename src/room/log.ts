import { errorLog, infoLog, warnLog } from '../log'
import { encodePacket, type Packet, participantIdToString } from '../protocol'
import type { Peer } from '../webrtc'
import type { RoomLink } from './link'

/** Packet boundary between typed room messages and raw data-channel strings. */
export const sendPacket = (peer: Peer, packet: Packet) => {
	// Keep packets typed until the last inch before the data channel.
	return peer.send(encodePacket(packet))
}

/** Log-safe link identity; SDP, file payloads, and streams stay out of diagnostics. */
export const linkLog = (link: RoomLink) => {
	// Logs need identities and roles, not raw SDP or file payloads.
	return {
		auth: link.auth,
		id: link.id,
		remoteId:
			link.remoteId == null ? null : participantIdToString(link.remoteId),
		role: link.role,
		source: link.source,
		beaconPeerId: link.beaconPeerId,
	}
}

/** Room-scoped warning log. */
export const warnRoom = (
	event: string,
	details: Record<string, unknown> = {},
) => {
	warnLog('room', event, details)
}

/** Room-scoped lifecycle log. */
export const infoRoom = (
	event: string,
	details: Record<string, unknown> = {},
) => {
	infoLog('room', event, details)
}

/** Room-scoped invariant failure log. */
export const errorRoom = (
	event: string,
	details: Record<string, unknown> = {},
) => {
	errorLog('room', event, details)
}
