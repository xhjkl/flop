import type { SignalExchangeId } from '../contracts/signal'
import { bytesToBase64Url } from './binary'

/** Cryptographic bytes for short-lived room ids and nonces. */
export const randomBytes = (byteLength: number) => {
	const bytes = new Uint8Array(byteLength)
	crypto.getRandomValues(bytes)
	return bytes
}

/** Base64url id for protocol-adjacent tokens shown in URLs or sockets. */
export const randomBase64Url = (byteLength: number) => {
	return bytesToBase64Url(randomBytes(byteLength))
}

/** New offer/answer correlation id with the shared signaling grammar. */
export const newSignalExchangeId = (): SignalExchangeId => {
	return randomBase64Url(16) as SignalExchangeId
}

/** Compact hexadecimal ids carried by participant and file packets. */
export const randomHex = (byteLength: number) => {
	return [...randomBytes(byteLength)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}
