import { bytesToBase64Url } from '../binary'
import { type RoomSecret, roomSecretBytes } from './secret'

export type RoomKeys = {
	authKey: CryptoKey
	infoHash: Uint8Array
}

const encoder = new TextEncoder()

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
	const infoHash = (
		await sha256(encoder.encode('flop tracker info-hash v1'), secretBytes)
	).slice(0, 20)
	const authBytes = await sha256(
		encoder.encode('flop tracker auth-key v1'),
		secretBytes,
	)
	const authKey = await crypto.subtle.importKey(
		'raw',
		authBytes,
		{ hash: 'SHA-256', name: 'HMAC' },
		false,
		['sign', 'verify'],
	)

	return { authKey, infoHash }
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
