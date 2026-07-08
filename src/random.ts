import { bytesToBase64Url } from './binary'

/** Cryptographic bytes for short-lived room ids and nonces. */
export const randomBytes = (length: number) => {
	const bytes = new Uint8Array(length)
	crypto.getRandomValues(bytes)
	return bytes
}

/** Base64url id for protocol-adjacent tokens shown in URLs or sockets. */
export const randomBase64Url = (length: number) => {
	return bytesToBase64Url(randomBytes(length))
}

/** Hex id for local-only labels where compact readability matters. */
export const randomHex = (length: number) => {
	return [...randomBytes(length)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}
