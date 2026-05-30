import { log } from '../log'
import { encodePacket, type Packet } from '../protocol'
import {
	type RoomKeys,
	randomNonce,
	signRoomAuth,
	verifyRoomAuth,
} from '../rendezvous/crypto'
import type { RoomLink } from './link'

/** Beacon auth owns the secret proof before anonymous links may join the room protocol. */
export type BeaconAuth = {
	handleAuthPacket: (link: RoomLink, message: Packet) => boolean
	sendChallenge: (link: RoomLink) => void
}

/** Auth handshake bound to the current room keys and mutable link registry. */
export const createBeaconAuth = (options: {
	closeLink: (link: RoomLink) => void
	linkStillCurrent: (link: RoomLink) => boolean
	roomKeys: () => RoomKeys | null
	verifyLink: (link: RoomLink) => void
}): BeaconAuth => {
	const sendChallenge = (link: RoomLink) => {
		// The host makes beacon candidates prove they know the room secret.
		const keys = options.roomKeys()
		if (keys == null) {
			log('error', 'room', 'auth.challenge.missing-room-keys', { link })
			options.closeLink(link)
			return
		}

		const nonce = randomNonce()
		link.authNonce = nonce
		if (!link.peer.send(encodePacket({ nonce, type: 'auth-challenge' }))) {
			log('warn', 'room', 'auth.challenge.send.failed', { link })
			options.closeLink(link)
			return
		}
		log('info', 'room', 'auth.challenge.sent', { link })
	}

	const answerChallenge = async (link: RoomLink, hostNonce: string) => {
		// The guest signs the host nonce, then asks the host to prove the same key.
		const keys = options.roomKeys()
		if (keys == null) {
			log('error', 'room', 'auth.response.missing-room-keys', { link })
			options.closeLink(link)
			return
		}

		const nonce = randomNonce()
		link.authNonce = nonce
		let mac: string
		try {
			mac = await signRoomAuth(keys.authKey, 'guest-to-host', hostNonce)
		} catch (error) {
			log('warn', 'room', 'auth.response.sign.failed', { error, link })
			options.closeLink(link)
			return
		}
		if (!options.linkStillCurrent(link)) return

		if (!link.peer.send(encodePacket({ mac, nonce, type: 'auth-response' }))) {
			log('warn', 'room', 'auth.response.send.failed', { link })
			options.closeLink(link)
			return
		}
		log('info', 'room', 'auth.response.sent', { link })
	}

	const acceptResponse = async (
		link: RoomLink,
		mac: string,
		guestNonce: string,
	) => {
		// Valid MACs tell apart public beacon noise from a peer with the invite secret.
		const keys = options.roomKeys()
		if (keys == null) {
			log('error', 'room', 'auth.accept.missing-room-keys', { link })
			options.closeLink(link)
			return
		}

		if (link.authNonce == null) {
			log('warn', 'room', 'auth.accept.missing-nonce', { link })
			options.closeLink(link)
			return
		}

		let verified: boolean
		try {
			verified = await verifyRoomAuth(
				keys.authKey,
				'guest-to-host',
				link.authNonce,
				mac,
			)
		} catch (error) {
			log('warn', 'room', 'auth.accept.verify.failed', { error, link })
			options.closeLink(link)
			return
		}
		if (!options.linkStillCurrent(link)) return

		if (!verified) {
			log('warn', 'room', 'auth.accept.rejected', { link })
			options.closeLink(link)
			return
		}

		let acceptMac: string
		try {
			acceptMac = await signRoomAuth(keys.authKey, 'host-to-guest', guestNonce)
		} catch (error) {
			log('warn', 'room', 'auth.accept.sign.failed', { error, link })
			options.closeLink(link)
			return
		}
		if (!options.linkStillCurrent(link)) return

		options.verifyLink(link)
		if (
			!link.peer.send(encodePacket({ mac: acceptMac, type: 'auth-accepted' }))
		) {
			log('warn', 'room', 'auth.accept.send.failed', { link })
			options.closeLink(link)
			return
		}
		log('info', 'room', 'auth.accept.sent', { link })
	}

	const acceptAccepted = async (link: RoomLink, mac: string) => {
		// The guest accepts only a host that can sign the guest's nonce.
		const keys = options.roomKeys()
		if (keys == null) {
			log('error', 'room', 'auth.accepted.missing-room-keys', { link })
			options.closeLink(link)
			return
		}

		if (link.authNonce == null) {
			log('warn', 'room', 'auth.accepted.missing-nonce', { link })
			options.closeLink(link)
			return
		}

		let verified: boolean
		try {
			verified = await verifyRoomAuth(
				keys.authKey,
				'host-to-guest',
				link.authNonce,
				mac,
			)
		} catch (error) {
			log('warn', 'room', 'auth.accepted.verify.failed', {
				error,
				link,
			})
			options.closeLink(link)
			return
		}
		if (!options.linkStillCurrent(link)) return

		if (!verified) {
			log('warn', 'room', 'auth.accepted.rejected', { link })
			options.closeLink(link)
			return
		}

		options.verifyLink(link)
		if (!link.peer.send(encodePacket({ type: 'hello' }))) {
			log('warn', 'room', 'auth.hello.send.failed', { link })
			options.closeLink(link)
			return
		}
		log('info', 'room', 'auth.hello.sent', { link })
	}

	const handleAuthPacket = (link: RoomLink, message: Packet) => {
		// Auth packets are consumed before room-role dispatch.
		switch (message.type) {
			case 'auth-challenge':
				if (link.source !== 'beacon' || link.role !== 'guest-rendezvous') {
					log('warn', 'room', 'auth.challenge.unexpected', { link })
					return true
				}

				void answerChallenge(link, message.nonce)
				return true
			case 'auth-accepted':
				if (link.source !== 'beacon' || link.role !== 'guest-rendezvous') {
					log('warn', 'room', 'auth.accepted.unexpected', { link })
					return true
				}

				void acceptAccepted(link, message.mac)
				return true
			case 'auth-response':
				if (link.source !== 'beacon' || link.role !== 'host-rendezvous') {
					log('warn', 'room', 'auth.response.unexpected', { link })
					return true
				}

				void acceptResponse(link, message.mac, message.nonce)
				return true
			default:
				return false
		}
	}

	return { handleAuthPacket, sendChallenge }
}
