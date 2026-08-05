import { base64ToBytes, bytesToBase64 } from '../../binary'
import { log } from '../../log'
import type { Packet, ParticipantId } from '../../protocol'
import { randomHex } from '../../random'
import type { RoomConnection } from '../link'
import type { FileTransferIssue, SharedFile } from '../participant'

type IncomingFileTransfer = {
	chunks: ArrayBuffer[]
	mime: string
	name: string
	transferredBytes: number
	size: number
}

/** Chunk and buffer sizes keep large drops responsive without flooding channels. */
const FILE_CHUNK_BYTES = 16 * 1024
const FILE_BUFFER_LOW_BYTES = 512 * 1024

/** In-flight file bytes; completed downloads are owned by their room peer. */
export const createRoomFileTransfers = (options: {
	connections: () => RoomConnection[]
	localParticipantId: () => ParticipantId | null
	sendPacket: (connections: RoomConnection[], packet: Packet) => number
	setIssue: (issue: FileTransferIssue | null) => void
	upsertFile: (participantId: ParticipantId, nextFile: SharedFile) => void
}) => {
	// Transfer ids are chosen by senders, so the authenticated sender is part of the key.
	const incomingFiles = new Map<
		ParticipantId,
		Map<string, IncomingFileTransfer>
	>()
	const markIncomingError = (
		participantId: ParticipantId,
		id: string,
		transfer: IncomingFileTransfer,
	) => {
		options.upsertFile(participantId, {
			id,
			name: transfer.name,
			transferredBytes: transfer.transferredBytes,
			size: transfer.size,
			state: 'failed',
			url: null,
		})
		const participantFiles = incomingFiles.get(participantId)
		participantFiles?.delete(id)
		if (participantFiles?.size === 0) incomingFiles.delete(participantId)
	}

	const handleFileStart = (
		participantId: ParticipantId,
		message: Extract<Packet, { type: 'file-start' }>,
	) => {
		const transfer: IncomingFileTransfer = {
			chunks: [],
			mime: message.mime,
			name: message.name,
			transferredBytes: 0,
			size: message.size,
		}
		const participantFiles =
			incomingFiles.get(participantId) ??
			new Map<string, IncomingFileTransfer>()
		participantFiles.set(message.id, transfer)
		incomingFiles.set(participantId, participantFiles)
		options.upsertFile(participantId, {
			id: message.id,
			name: message.name,
			transferredBytes: 0,
			size: message.size,
			state: 'receiving',
			url: null,
		})
	}

	const handleFileChunk = (
		participantId: ParticipantId,
		message: Extract<Packet, { type: 'file-chunk' }>,
	) => {
		// Unknown sender/id pairs are stale packets, never another sender's transfer.
		const transfer = incomingFiles.get(participantId)?.get(message.id) ?? null
		if (transfer == null) return

		let bytes: Uint8Array<ArrayBuffer>
		try {
			bytes = base64ToBytes(message.data)
		} catch (error) {
			log('warn', 'room', 'file.chunk.decode.failed', {
				error,
				id: message.id,
				participantId,
			})
			markIncomingError(participantId, message.id, transfer)
			return
		}

		if (transfer.transferredBytes + bytes.byteLength > transfer.size) {
			log('warn', 'room', 'file.chunk.too-large', {
				chunkBytes: bytes.byteLength,
				id: message.id,
				participantId,
				transferredBytes: transfer.transferredBytes,
				size: transfer.size,
			})
			markIncomingError(participantId, message.id, transfer)
			return
		}

		transfer.chunks.push(bytes.buffer)
		transfer.transferredBytes += bytes.byteLength
		options.upsertFile(participantId, {
			id: message.id,
			name: transfer.name,
			transferredBytes: Math.min(transfer.transferredBytes, transfer.size),
			size: transfer.size,
			state: 'receiving',
			url: null,
		})
	}

	const handleFileEnd = (
		participantId: ParticipantId,
		message: Extract<Packet, { type: 'file-end' }>,
	) => {
		// Only at the end do bytes become a downloadable browser URL.
		const participantFiles = incomingFiles.get(participantId)
		const transfer = participantFiles?.get(message.id) ?? null
		if (transfer == null) return

		const blob = new Blob(transfer.chunks, {
			type: transfer.mime || 'application/octet-stream',
		})
		if (blob.size !== transfer.size) {
			log('warn', 'room', 'file.end.size-mismatch', {
				actual: blob.size,
				expected: transfer.size,
				id: message.id,
				participantId,
			})
			transfer.transferredBytes = blob.size
			markIncomingError(participantId, message.id, transfer)
			return
		}

		const url = URL.createObjectURL(blob)
		participantFiles?.delete(message.id)
		if (participantFiles?.size === 0) incomingFiles.delete(participantId)
		options.upsertFile(participantId, {
			id: message.id,
			name: transfer.name,
			transferredBytes: blob.size,
			size: transfer.size,
			state: 'download',
			url,
		})
	}

	const sendFile = async (
		file: File,
		connections: RoomConnection[],
		participantId: ParticipantId,
	) => {
		// Recipient connections are fixed at drop time so progress has a stable denominator.
		const id = randomHex(12)
		// Membership identity invalidates asynchronous file work when the room changes.
		const belongsToCurrentRoom = () =>
			options.localParticipantId() === participantId

		options.upsertFile(participantId, {
			id,
			name: file.name,
			transferredBytes: 0,
			size: file.size,
			state: 'sending',
			url: null,
		})

		let partiallyDelivered = false
		let transferredBytes = 0
		const sendFilePacket = (packet: Packet, event: string) => {
			if (!belongsToCurrentRoom()) throw new Error('File room changed')
			const sent = options.sendPacket(connections, packet)
			if (sent !== connections.length) {
				partiallyDelivered = true
				log('warn', 'room', event, {
					id,
					sent,
					targets: connections.length,
				})
			}
			if (sent === 0) throw new Error('File channel closed')
		}

		try {
			sendFilePacket(
				{
					id,
					mime: file.type,
					name: file.name,
					size: file.size,
					type: 'file-start',
				},
				'file.start.partial-send',
			)

			for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
				const chunk = file.slice(offset, offset + FILE_CHUNK_BYTES)
				const bytes = new Uint8Array(await chunk.arrayBuffer())
				sendFilePacket(
					{
						data: bytesToBase64(bytes),
						id,
						type: 'file-chunk',
					},
					'file.chunk.partial-send',
				)

				transferredBytes = offset + bytes.byteLength
				options.upsertFile(participantId, {
					id,
					name: file.name,
					transferredBytes,
					size: file.size,
					state: 'sending',
					url: null,
				})
				await Promise.all(
					connections.map((connection) =>
						connection.rtc.waitForBufferBelow(FILE_BUFFER_LOW_BYTES),
					),
				)
			}

			sendFilePacket({ id, type: 'file-end' }, 'file.end.partial-send')
			if (partiallyDelivered) options.setIssue('partial-delivery')
			options.upsertFile(participantId, {
				id,
				name: file.name,
				transferredBytes: file.size,
				size: file.size,
				state: 'sent',
				url: null,
			})
		} catch (error) {
			if (belongsToCurrentRoom()) {
				options.upsertFile(participantId, {
					id,
					name: file.name,
					transferredBytes,
					size: file.size,
					state: 'failed',
					url: null,
				})
			}
			throw error
		}
	}

	const sendFiles = async (files: File[]) => {
		// Drops without peers become composer feedback, not hidden work.
		if (files.length === 0) return
		options.setIssue(null)

		const participantId = options.localParticipantId()
		const connections = options.connections()
		if (participantId == null || connections.length === 0) {
			options.setIssue('no-peers')
			return
		}

		try {
			for (const file of files) {
				await sendFile(file, connections, participantId)
			}
		} catch (error) {
			if (options.localParticipantId() !== participantId) return
			log('warn', 'room', 'file.send.failed', { error })
			options.setIssue('stopped')
		}
	}

	const abortIncomingFrom = (participantId: ParticipantId) => {
		const participantFiles = incomingFiles.get(participantId)
		for (const [id, transfer] of participantFiles ?? []) {
			log('warn', 'room', 'file.receive.aborted', {
				id,
				participantId,
				reason: 'connection-closed-or-membership-removed',
			})
			markIncomingError(participantId, id, transfer)
		}
	}

	return {
		abortIncomingFrom,
		handleFileChunk,
		handleFileEnd,
		handleFileStart,
		sendFiles,
	}
}
