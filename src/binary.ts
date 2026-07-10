/** Base64 bridge for browser APIs that still accept binary strings. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
	let binary = ''

	// Bound the spread so large payloads stay below engine argument-count limits.
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}

	return btoa(binary)
}

export const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}

	return bytes
}

export const bytesToBase64Url = (bytes: Uint8Array): string => {
	return bytesToBase64(bytes)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

export const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
	const base64 = value.trim().replaceAll('-', '+').replaceAll('_', '/')
	const padding = (4 - (base64.length % 4)) % 4
	return base64ToBytes(base64 + '='.repeat(padding))
}

export const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return copy.buffer
}
