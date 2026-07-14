import type { SignalDescription } from '../contracts/signal'
import {
	base64UrlToBytes,
	bytesToArrayBuffer,
	bytesToBase64Url,
} from './binary'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const encodeSignalText = (description: SignalDescription) => {
	// The invite code is SDP type plus SDP body. JSON would only add ceremony here.
	if (description.type === 'offer') return `o\n${description.sdp}`
	if (description.type === 'answer') return `a\n${description.sdp}`

	throw new Error('Unsupported signal description')
}

const decodeSignalText = (value: string): SignalDescription => {
	if (value.startsWith('o\n')) return { type: 'offer', sdp: value.slice(2) }
	if (value.startsWith('a\n')) return { type: 'answer', sdp: value.slice(2) }

	throw new Error('Invalid signal description')
}

const compressSignalText = async (value: string) => {
	if (typeof CompressionStream === 'undefined') return null

	// Native deflate keeps URLs small without making the bundle pay for a codec.
	const input = encoder.encode(value)
	const stream = new Blob([bytesToArrayBuffer(input)])
		.stream()
		.pipeThrough(new CompressionStream('deflate-raw'))
	const compressed = new Uint8Array(await new Response(stream).arrayBuffer())
	return bytesToBase64Url(compressed)
}

const decompressSignalText = async (value: string) => {
	if (typeof DecompressionStream === 'undefined') return null

	const compressed = base64UrlToBytes(value)
	const stream = new Blob([bytesToArrayBuffer(compressed)])
		.stream()
		.pipeThrough(new DecompressionStream('deflate-raw'))
	const decompressed = await new Response(stream).arrayBuffer()
	return decoder.decode(decompressed)
}

/** Encode SDP for copy-paste links and reply codes. */
export const encodeSignal = async (
	description: SignalDescription,
): Promise<string> => {
	const signalText = encodeSignalText(description)

	try {
		const compressed = await compressSignalText(signalText)
		if (compressed != null) return compressed
	} catch {}

	return bytesToBase64Url(encoder.encode(signalText))
}

/** Decode SDP from raw text, compressed URL text, or base64url fallback. */
export const decodeSignal = async (
	value: string,
): Promise<SignalDescription> => {
	// Decode from friendliest to most packed, so localhost experiments stay easy to inspect.
	try {
		return decodeSignalText(value)
	} catch {}

	try {
		const signalText = await decompressSignalText(value)
		if (signalText != null) return decodeSignalText(signalText)
	} catch {}

	return decodeSignalText(decoder.decode(base64UrlToBytes(value)))
}
