import { bytesToBase64Url } from '../binary'
import { type RoomSecret, roomSecretBytes } from './secret'

export type RoomKeys = {
	authKey: CryptoKey
	discoveryId: Uint8Array
}

const encoder = new TextEncoder()
const DISCOVERY_ID_DOMAIN = encoder.encode('flop:rendezvous')
const AUTH_KEY_DOMAIN = encoder.encode('flop:yo')

const randomBytes = (length: number) => {
	const bytes = new Uint8Array(length)
	crypto.getRandomValues(bytes)
	return bytes
}

const concatBytes = (...parts: Uint8Array[]) => {
	const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
	const bytes = new Uint8Array(length)
	let offset = 0

	for (const part of parts) {
		bytes.set(part, offset)
		offset += part.byteLength
	}

	return bytes
}

const sha256 = async (...parts: Uint8Array[]) => {
	const digest = await crypto.subtle.digest('SHA-256', concatBytes(...parts))
	return new Uint8Array(digest)
}

export const randomNonce = () => {
	return bytesToBase64Url(randomBytes(16))
}

export const deriveRoomKeys = async (secret: RoomSecret): Promise<RoomKeys> => {
	const secretBytes = roomSecretBytes(secret)
	// The beacon sees only this truncated public room name. The full room secret
	// still protects auth below and never leaves the browsers.
	const discoveryId = (await sha256(DISCOVERY_ID_DOMAIN, secretBytes)).slice(
		0,
		20,
	)
	const authBytes = await sha256(AUTH_KEY_DOMAIN, secretBytes)
	const authKey = await crypto.subtle.importKey(
		'raw',
		authBytes,
		{ hash: 'SHA-256', name: 'HMAC' },
		false,
		['sign', 'verify'],
	)

	return { authKey, discoveryId }
}

export const signRoomAuth = async (key: CryptoKey, nonce: string) => {
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(nonce))
	return bytesToBase64Url(new Uint8Array(mac))
}

export const verifyRoomAuth = async (
	key: CryptoKey,
	nonce: string,
	mac: string,
) => {
	const expected = await signRoomAuth(key, nonce)
	return mac === expected
}
