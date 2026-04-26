import type { Packet, ParticipantId } from '../protocol'
import type { PortraitFileState } from '../state'

// File transfer is transport work, but the UI result is still portrait activity.
export type IncomingFileTransfer = {
	chunks: ArrayBuffer[]
	from: ParticipantId
	mime: string
	name: string
	receivedBytes: number
	size: number
}

export type FileProgress = {
	id: string
	name: string
	receivedBytes: number
	size: number
	state: PortraitFileState['state']
	url: string | null
}

export const FILE_CHUNK_BYTES = 16 * 1024
// Keep data channels breathing while large drops are in flight.
export const FILE_BUFFER_LOW_BYTES = 512 * 1024

export const createIncomingFileTransfer = (
	from: ParticipantId,
	message: Extract<Packet, { type: 'file-start' }>,
): IncomingFileTransfer => {
	return {
		chunks: [],
		from,
		mime: message.mime,
		name: message.name,
		receivedBytes: 0,
		size: message.size,
	}
}

export const fileProgressState = (file: FileProgress): PortraitFileState => {
	const progress =
		file.size <= 0
			? 100
			: Math.min(100, Math.round((file.receivedBytes / file.size) * 100))

	return {
		id: file.id,
		name: file.name,
		progress,
		state: file.state,
		url: file.url,
	}
}

export const randomTransferId = () => {
	const bytes = new Uint8Array(12)
	crypto.getRandomValues(bytes)
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
