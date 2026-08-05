import type { BeaconPeerId } from '../../contracts/beacon'
import type { SignalExchangeId } from '../../contracts/signal'
import type { MediaPresence } from '../protocol'
import type { RtcPeer } from '../webrtc'

/** Local side during rendezvous and its role after room admission. */
export type LocalRoomRole = 'guest' | 'host'

/** Setup path plus correlation or proof state retained through its handshake. */
export type ConnectionOrigin =
	| { kind: 'manual'; localRole: LocalRoomRole }
	| {
			authenticated: boolean
			exchangeId: SignalExchangeId | null
			kind: 'beacon'
			peerId: BeaconPeerId
			localRole: LocalRoomRole
	  }
	| { exchangeId: SignalExchangeId | null; kind: 'mesh' }

/** Browser transport whose participant assignment may precede channel opening. */
export type RoomConnection = {
	connected: boolean
	mediaPresence: MediaPresence | null
	mediaStream: MediaStream | null
	readonly origin: ConnectionOrigin
	readonly rtc: RtcPeer
}

type BeaconConnection = RoomConnection & {
	origin: Extract<ConnectionOrigin, { kind: 'beacon' }>
}

/** Connection created through invite-link discovery. */
export const isBeaconConnection = (
	connection: RoomConnection,
): connection is BeaconConnection => connection.origin.kind === 'beacon'

/** Manual possession and roster-addressed mesh grant access; beacon requires proof. */
export const hasRoomAccess = (connection: RoomConnection) => {
	return !isBeaconConnection(connection) || connection.origin.authenticated
}
