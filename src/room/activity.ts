import type { Packet, ParticipantId } from '../protocol'

// File transfer is transport work, but the UI result is still portrait activity.
export type IncomingFileTransfer = {
	chunks: ArrayBuffer[]
	from: ParticipantId
	mime: string
	name: string
	receivedBytes: number
	size: number
}

export const FILE_CHUNK_BYTES = 16 * 1024
// Keep data channels breathing while large drops are in flight.
export const FILE_BUFFER_LOW_BYTES = 512 * 1024

export const createIncomingFileTransfer = (
	from: ParticipantId,
	message: Extract<Packet, { type: 'file-start' }>,
): IncomingFileTransfer => {
	// The portrait gets progress; bytes wait here until the file is whole.
	return {
		chunks: [],
		from,
		mime: message.mime,
		name: message.name,
		receivedBytes: 0,
		size: message.size,
	}
}

export const randomTransferId = () => {
	// Transfer ids only need to be unique inside this short-lived room.
	const bytes = new Uint8Array(12)
	crypto.getRandomValues(bytes)
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
