import { log } from '../../log'
import { encodePacket, type Packet } from '../../protocol'
import {
	type RoomKeys,
	randomNonce,
	signRoomAuth,
	verifyRoomAuth,
} from '../../rendezvous/crypto'
import { isBeaconConnection, type RoomConnection } from '../link'

/** Mutual room-secret proof for connections created through the public beacon. */
export const createBeaconAuth = (options: {
	closeConnection: (connection: RoomConnection) => void
	connectionIsCurrent: (connection: RoomConnection) => boolean
	roomKeys: () => RoomKeys | null
	verifyConnection: (connection: RoomConnection) => void
}) => {
	const nonces = new WeakMap<RoomConnection, string>()

	const sendChallenge = (connection: RoomConnection) => {
		// A host challenges each anonymous beacon connection before accepting packets.
		const keys = options.roomKeys()
		if (keys == null) {
			log('error', 'room', 'auth.challenge.missing-room-keys', { connection })
			options.closeConnection(connection)
			return
		}

		const nonce = randomNonce()
		nonces.set(connection, nonce)
		if (
			!connection.rtc.trySend(encodePacket({ nonce, type: 'auth-challenge' }))
		) {
			log('warn', 'room', 'auth.challenge.send.failed', { connection })
			options.closeConnection(connection)
			return
		}
		log('info', 'room', 'auth.challenge.sent', { connection })
	}

	const answerChallenge = async (
		connection: RoomConnection,
		hostNonce: string,
	) => {
		// The guest signs the host nonce, then asks the host to prove the same key.
		const keys = options.roomKeys()
		if (keys == null) {
			log('error', 'room', 'auth.response.missing-room-keys', { connection })
			options.closeConnection(connection)
			return
		}

		const nonce = randomNonce()
		nonces.set(connection, nonce)
		let mac: string
		try {
			mac = await signRoomAuth(keys.authKey, 'guest-to-host', hostNonce)
		} catch (error) {
			log('warn', 'room', 'auth.response.sign.failed', {
				connection,
				error,
			})
			options.closeConnection(connection)
			return
		}
		if (!options.connectionIsCurrent(connection)) return

		if (
			!connection.rtc.trySend(
				encodePacket({ mac, nonce, type: 'auth-response' }),
			)
		) {
			log('warn', 'room', 'auth.response.send.failed', { connection })
			options.closeConnection(connection)
			return
		}
		log('info', 'room', 'auth.response.sent', { connection })
	}

	const acceptResponse = async (
		connection: RoomConnection,
		mac: string,
		guestNonce: string,
	) => {
		// Only a guest with the invite secret can authenticate the host's nonce.
		const keys = options.roomKeys()
		if (keys == null) {
			log('error', 'room', 'auth.accept.missing-room-keys', { connection })
			options.closeConnection(connection)
			return
		}

		const nonce = nonces.get(connection)
		if (nonce == null) {
			log('warn', 'room', 'auth.accept.missing-nonce', { connection })
			options.closeConnection(connection)
			return
		}

		let verified: boolean
		try {
			verified = await verifyRoomAuth(keys.authKey, 'guest-to-host', nonce, mac)
		} catch (error) {
			log('warn', 'room', 'auth.accept.verify.failed', {
				connection,
				error,
			})
			options.closeConnection(connection)
			return
		}
		if (!options.connectionIsCurrent(connection)) return

		if (!verified) {
			log('warn', 'room', 'auth.accept.rejected', { connection })
			options.closeConnection(connection)
			return
		}

		let acceptMac: string
		try {
			acceptMac = await signRoomAuth(keys.authKey, 'host-to-guest', guestNonce)
		} catch (error) {
			log('warn', 'room', 'auth.accept.sign.failed', { connection, error })
			options.closeConnection(connection)
			return
		}
		if (!options.connectionIsCurrent(connection)) return

		nonces.delete(connection)
		options.verifyConnection(connection)
		if (
			!connection.rtc.trySend(
				encodePacket({ mac: acceptMac, type: 'auth-accepted' }),
			)
		) {
			log('warn', 'room', 'auth.accept.send.failed', { connection })
			options.closeConnection(connection)
			return
		}
		log('info', 'room', 'auth.accept.sent', { connection })
	}

	const acceptAccepted = async (connection: RoomConnection, mac: string) => {
		// The guest accepts only a host that can sign the guest's nonce.
		const keys = options.roomKeys()
		if (keys == null) {
			log('error', 'room', 'auth.accepted.missing-room-keys', { connection })
			options.closeConnection(connection)
			return
		}

		const nonce = nonces.get(connection)
		if (nonce == null) {
			log('warn', 'room', 'auth.accepted.missing-nonce', { connection })
			options.closeConnection(connection)
			return
		}

		let verified: boolean
		try {
			verified = await verifyRoomAuth(keys.authKey, 'host-to-guest', nonce, mac)
		} catch (error) {
			log('warn', 'room', 'auth.accepted.verify.failed', {
				connection,
				error,
			})
			options.closeConnection(connection)
			return
		}
		if (!options.connectionIsCurrent(connection)) return

		if (!verified) {
			log('warn', 'room', 'auth.accepted.rejected', { connection })
			options.closeConnection(connection)
			return
		}

		nonces.delete(connection)
		options.verifyConnection(connection)
		if (!connection.rtc.trySend(encodePacket({ type: 'hello' }))) {
			log('warn', 'room', 'auth.hello.send.failed', { connection })
			options.closeConnection(connection)
			return
		}
		log('info', 'room', 'auth.hello.sent', { connection })
	}

	const handleAuthPacket = (connection: RoomConnection, message: Packet) => {
		if (
			message.type !== 'auth-challenge' &&
			message.type !== 'auth-accepted' &&
			message.type !== 'auth-response'
		) {
			return false
		}
		if (isBeaconConnection(connection) && connection.origin.authenticated) {
			// Authentication is single-use; repeats cannot alter an admitted connection.
			log('warn', 'room', 'auth.packet.after-acceptance', {
				connection,
				type: message.type,
			})
			return true
		}

		switch (message.type) {
			case 'auth-challenge':
				if (
					!isBeaconConnection(connection) ||
					connection.origin.localRole !== 'guest'
				) {
					log('warn', 'room', 'auth.challenge.unexpected', { connection })
					return true
				}

				void answerChallenge(connection, message.nonce)
				return true
			case 'auth-accepted':
				if (
					!isBeaconConnection(connection) ||
					connection.origin.localRole !== 'guest'
				) {
					log('warn', 'room', 'auth.accepted.unexpected', { connection })
					return true
				}

				void acceptAccepted(connection, message.mac)
				return true
			case 'auth-response':
				if (
					!isBeaconConnection(connection) ||
					connection.origin.localRole !== 'host'
				) {
					log('warn', 'room', 'auth.response.unexpected', { connection })
					return true
				}

				void acceptResponse(connection, message.mac, message.nonce)
				return true
		}
	}

	return { handleAuthPacket, sendChallenge }
}
