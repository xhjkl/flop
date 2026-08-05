import { log } from '../log'
import { decodePacket, encodePacket } from '../protocol'
import type { GuestFlow } from './entry/guest'
import type { HostFlow } from './entry/host'
import { initialGuestEntry } from './entry/state'
import { hasRoomAccess, isBeaconConnection, type RoomConnection } from './link'
import type { RoomSession } from './session'

/** Route RTC callbacks through the connection's current admission or participant. */
export const createRoomLinkEvents = (
	room: RoomSession,
	host: HostFlow,
	guest: GuestFlow,
) => {
	const handlePeerClose = (connection: RoomConnection) => {
		const peer = room.connections.peerByConnection(connection)
		if (peer == null) return false

		room.connections.remove(connection)

		const membership = room.membership()
		if (room.localRoomRole() === 'guest') {
			if (peer.id === membership?.hostId) {
				room.closeRoom()
			} else {
				room.mesh.connectMissingPeers()
			}
			return true
		}

		if (room.localRoomRole() !== 'host') return true
		room.peers.remove(peer.id)
		room.packets.broadcastRoster()
		if (
			room.connections.openPeerConnections().length === 0 &&
			room.connections.manualAdmission('host') == null
		) {
			void host.refreshInvite()
		}
		return true
	}

	const onOpen = (connection: RoomConnection) => {
		if (!room.connections.isCurrent(connection)) return

		connection.connected = true
		log('info', 'room', 'connection.open', { connection })

		if (isBeaconConnection(connection) && !hasRoomAccess(connection)) {
			if (connection.origin.localRole === 'host') {
				room.auth.sendChallenge(connection)
			}
			return
		}

		const peer = room.connections.peerByConnection(connection)
		if (peer == null) {
			if (
				connection.origin.kind !== 'mesh' &&
				connection.origin.localRole === 'guest'
			) {
				// Guest rendezvous starts only after the data channel and any auth are ready.
				connection.rtc.trySend(encodePacket({ type: 'hello' }))
			}
			return
		}

		// Mesh connections open after assignment and need the current local presence.
		room.packets.sendPortraitState(connection)
	}

	const onMessage = (connection: RoomConnection, text: string) => {
		if (!room.connections.isCurrent(connection)) return

		const message = decodePacket(text)
		if (message == null) {
			log('warn', 'room', 'packet.decode.failed', {
				connection,
				length: text.length,
			})
			return
		}
		if (room.auth.handleAuthPacket(connection, message)) return
		if (isBeaconConnection(connection) && !hasRoomAccess(connection)) {
			log('warn', 'room', 'packet.before-auth', {
				connection,
				type: message.type,
			})
			return
		}

		switch (connection.origin.kind) {
			case 'beacon':
			case 'manual':
				if (connection.origin.localRole === 'host') {
					host.handleMessage(connection, message)
				} else {
					guest.handleMessage(connection, message)
				}
				return
			case 'mesh': {
				const peer = room.connections.peerByConnection(connection)
				if (peer == null) {
					log('warn', 'room', 'mesh.packet.unassigned', {
						connection,
						type: message.type,
					})
					return
				}
				room.packets.handleActivity(peer.id, message)
				return
			}
		}
	}

	const onClose = (connection: RoomConnection) => {
		// Closing a replaced connection must not clear its successor.
		if (!room.connections.isCurrent(connection)) return
		log('info', 'room', 'connection.close', { connection })
		if (handlePeerClose(connection)) return

		const origin = connection.origin
		room.connections.remove(connection)
		if (origin.kind === 'mesh') return

		const membership = room.membership()
		if (origin.localRole === 'host') {
			if (origin.kind === 'manual' && room.localRoomRole() === 'host') {
				// Hosts keep one manual admission ready whenever its channel closes naturally.
				void host.refreshInvite()
			}
			return
		}

		if (origin.kind === 'beacon' && membership == null) return
		if (origin.kind === 'manual' && membership == null) {
			const inviteText =
				room.state.entry.side === 'guest' ? room.state.entry.inviteText : ''
			log('warn', 'room', 'manual.reply.direct-connection.failed', {
				connection,
				nextStep: 'fresh-reply-or-network-change',
			})
			room.rendezvous.stop()
			room.setState('entry', {
				...initialGuestEntry(),
				inviteText,
				issue: 'direct-connection-failed',
			})
			return
		}

		// The assigned host connection should own this close; an unassigned one is fatal.
		room.closeRoom()
	}

	return { onClose, onMessage, onOpen }
}
