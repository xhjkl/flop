import type { Packet, ParticipantId } from '../protocol'
import { randomHex } from '../random'

/** Incoming transfer bytes held outside Solid until the file completes. */
export type IncomingFileTransfer = {
	chunks: ArrayBuffer[]
	from: ParticipantId
	mime: string
	name: string
	transferredBytes: number
	size: number
}

/** File chunk size chosen for responsive progress without flooding data channels. */
export const FILE_CHUNK_BYTES = 16 * 1024
/** Buffered amount threshold that keeps data channels breathing during large drops. */
export const FILE_BUFFER_LOW_BYTES = 512 * 1024

/** Incoming transfer bucket created from a file-start packet. */
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
		transferredBytes: 0,
		size: message.size,
	}
}

/** Transfer id scoped to this short-lived room. */
export const randomTransferId = () => {
	return randomHex(12)
}
