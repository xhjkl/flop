// Browser APIs still make binary take the scenic route through strings. Keep that tax here.
export function bytesToBase64(bytes: Uint8Array): string {
	let binary = ''

	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}

	return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}

	return bytes
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64(bytes)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const base64 = value.trim().replaceAll('-', '+').replaceAll('_', '/')
	const padding = (4 - (base64.length % 4)) % 4
	return base64ToBytes(base64 + '='.repeat(padding))
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? (bytes.buffer as ArrayBuffer)
		: (bytes.slice().buffer as ArrayBuffer)
}
