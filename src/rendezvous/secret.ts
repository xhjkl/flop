export type RoomSecret = string & { readonly RoomSecret: unique symbol }

const Z_BASE_32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'
const ROOM_SECRET_BYTES = 16
export const ROOM_SECRET_LENGTH = 26

const alphabetIndex = new Map(
	[...Z_BASE_32_ALPHABET].map((letter, index) => [letter, index]),
)

const encodeZBase32 = (bytes: Uint8Array) => {
	let bits = 0
	let value = 0
	let output = ''

	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8

		while (bits >= 5) {
			output += Z_BASE_32_ALPHABET[(value >>> (bits - 5)) & 31]
			bits -= 5
			value &= (1 << bits) - 1
		}
	}

	if (bits > 0) {
		output += Z_BASE_32_ALPHABET[(value << (5 - bits)) & 31]
	}

	return output
}

const decodeZBase32 = (value: string) => {
	let bits = 0
	let buffer = 0
	const output: number[] = []

	for (const letter of value) {
		const index = alphabetIndex.get(letter)
		if (index == null) return null

		buffer = (buffer << 5) | index
		bits += 5

		while (bits >= 8) {
			output.push((buffer >>> (bits - 8)) & 255)
			bits -= 8
			buffer &= (1 << bits) - 1
		}
	}

	if (bits > 0 && buffer !== 0) return null

	return new Uint8Array(output)
}

export const parseRoomSecret = (value: string): RoomSecret | null => {
	const secret = value.trim().toLowerCase()
	if (secret.length !== ROOM_SECRET_LENGTH) return null

	const bytes = decodeZBase32(secret)
	if (bytes == null || bytes.byteLength !== ROOM_SECRET_BYTES) return null

	return secret as RoomSecret
}

export const randomRoomSecret = (): RoomSecret => {
	const bytes = new Uint8Array(ROOM_SECRET_BYTES)
	crypto.getRandomValues(bytes)
	return encodeZBase32(bytes) as RoomSecret
}

export const roomSecretBytes = (secret: RoomSecret) => {
	const bytes = decodeZBase32(secret)
	if (bytes == null || bytes.byteLength !== ROOM_SECRET_BYTES) {
		throw new Error('Invalid room secret')
	}

	return bytes
}
