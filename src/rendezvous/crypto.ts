import { bytesToBase64Url } from '../binary'
import { type RoomSecret, roomSecretBytes } from './secret'

export type RoomKeys = {
	authKey: CryptoKey
	discoveryId: Uint8Array
}

export type RoomAuthPurpose = 'guest-to-host' | 'host-to-guest'

const encoder = new TextEncoder()
const DISCOVERY_ID_DOMAIN = encoder.encode('flop:where')
const AUTH_KEY_DOMAIN = encoder.encode('flop:hey')
const ROOM_AUTH_TAG = 'flop:knock'

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
	// The invite fragment is the secret. The Worker sees only this derived
	// lookup id; joining still requires the separate HMAC key derived below.
	const discoveryId = await sha256(DISCOVERY_ID_DOMAIN, secretBytes)
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

const roomAuthPayload = (
	purpose: RoomAuthPurpose,
	nonce: string,
	transcript: string,
) => {
	// A valid knock proves the invite secret and this exact RTC offer/answer.
	return encoder.encode(
		JSON.stringify([ROOM_AUTH_TAG, purpose, nonce, transcript]),
	)
}

export const signRoomAuth = async (
	key: CryptoKey,
	purpose: RoomAuthPurpose,
	nonce: string,
	transcript: string,
) => {
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		roomAuthPayload(purpose, nonce, transcript),
	)
	return bytesToBase64Url(new Uint8Array(mac))
}

export const verifyRoomAuth = async (
	key: CryptoKey,
	purpose: RoomAuthPurpose,
	nonce: string,
	transcript: string,
	mac: string,
) => {
	const expected = await signRoomAuth(key, purpose, nonce, transcript)
	return mac === expected
}
