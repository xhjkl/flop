import type { Packet } from '../protocol'
import {
	type RoomKeys,
	randomNonce,
	signRoomAuth,
	verifyRoomAuth,
} from '../rendezvous/crypto'
import type { RoomLink } from './link'
import { errorRoom, infoRoom, linkLog, sendPacket, warnRoom } from './log'

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
			errorRoom('auth.challenge.missing-room-keys', { link: linkLog(link) })
			options.closeLink(link)
			return
		}

		const nonce = randomNonce()
		link.authNonce = nonce
		if (!sendPacket(link.peer, { nonce, type: 'auth-challenge' })) {
			warnRoom('auth.challenge.send.failed', { link: linkLog(link) })
			options.closeLink(link)
			return
		}
		infoRoom('auth.challenge.sent', { link: linkLog(link) })
	}

	const answerChallenge = async (link: RoomLink, hostNonce: string) => {
		// The guest signs the host nonce, then asks the host to prove the same key.
		const keys = options.roomKeys()
		if (keys == null) {
			errorRoom('auth.response.missing-room-keys', { link: linkLog(link) })
			options.closeLink(link)
			return
		}

		const nonce = randomNonce()
		link.authNonce = nonce
		let mac: string
		try {
			mac = await signRoomAuth(keys.authKey, 'guest-to-host', hostNonce)
		} catch (error) {
			warnRoom('auth.response.sign.failed', { error, link: linkLog(link) })
			options.closeLink(link)
			return
		}
		if (!options.linkStillCurrent(link)) return

		if (!sendPacket(link.peer, { mac, nonce, type: 'auth-response' })) {
			warnRoom('auth.response.send.failed', { link: linkLog(link) })
			options.closeLink(link)
			return
		}
		infoRoom('auth.response.sent', { link: linkLog(link) })
	}

	const acceptResponse = async (
		link: RoomLink,
		mac: string,
		guestNonce: string,
	) => {
		// Valid MACs tell apart public beacon noise from a peer with the invite secret.
		const keys = options.roomKeys()
		if (keys == null) {
			errorRoom('auth.accept.missing-room-keys', { link: linkLog(link) })
			options.closeLink(link)
			return
		}

		if (link.authNonce == null) {
			warnRoom('auth.accept.missing-nonce', { link: linkLog(link) })
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
			warnRoom('auth.accept.verify.failed', { error, link: linkLog(link) })
			options.closeLink(link)
			return
		}
		if (!options.linkStillCurrent(link)) return

		if (!verified) {
			warnRoom('auth.accept.rejected', { link: linkLog(link) })
			options.closeLink(link)
			return
		}

		let acceptMac: string
		try {
			acceptMac = await signRoomAuth(keys.authKey, 'host-to-guest', guestNonce)
		} catch (error) {
			warnRoom('auth.accept.sign.failed', { error, link: linkLog(link) })
			options.closeLink(link)
			return
		}
		if (!options.linkStillCurrent(link)) return

		options.verifyLink(link)
		if (!sendPacket(link.peer, { mac: acceptMac, type: 'auth-accepted' })) {
			warnRoom('auth.accept.send.failed', { link: linkLog(link) })
			options.closeLink(link)
			return
		}
		infoRoom('auth.accept.sent', { link: linkLog(link) })
	}

	const acceptAccepted = async (link: RoomLink, mac: string) => {
		// The guest accepts only a host that can sign the guest's nonce.
		const keys = options.roomKeys()
		if (keys == null) {
			errorRoom('auth.accepted.missing-room-keys', { link: linkLog(link) })
			options.closeLink(link)
			return
		}

		if (link.authNonce == null) {
			warnRoom('auth.accepted.missing-nonce', { link: linkLog(link) })
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
			warnRoom('auth.accepted.verify.failed', {
				error,
				link: linkLog(link),
			})
			options.closeLink(link)
			return
		}
		if (!options.linkStillCurrent(link)) return

		if (!verified) {
			warnRoom('auth.accepted.rejected', { link: linkLog(link) })
			options.closeLink(link)
			return
		}

		options.verifyLink(link)
		if (!sendPacket(link.peer, { type: 'hello' })) {
			warnRoom('auth.hello.send.failed', { link: linkLog(link) })
			options.closeLink(link)
			return
		}
		infoRoom('auth.hello.sent', { link: linkLog(link) })
	}

	const handleAuthPacket = (link: RoomLink, message: Packet) => {
		// Auth packets are consumed before room-role dispatch.
		switch (message.type) {
			case 'auth-challenge':
				if (link.source !== 'beacon' || link.role !== 'guest-rendezvous') {
					warnRoom('auth.challenge.unexpected', { link: linkLog(link) })
					return true
				}

				void answerChallenge(link, message.nonce)
				return true
			case 'auth-accepted':
				if (link.source !== 'beacon' || link.role !== 'guest-rendezvous') {
					warnRoom('auth.accepted.unexpected', { link: linkLog(link) })
					return true
				}

				void acceptAccepted(link, message.mac)
				return true
			case 'auth-response':
				if (link.source !== 'beacon' || link.role !== 'host-rendezvous') {
					warnRoom('auth.response.unexpected', { link: linkLog(link) })
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
