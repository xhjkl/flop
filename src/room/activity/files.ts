import { base64ToBytes, bytesToBase64 } from '../../binary'
import { log } from '../../log'
import type { Packet, ParticipantId } from '../../protocol'
import { randomHex } from '../../random'
import type { RoomLink } from '../link'
import type { ParticipantFile } from '../participant'
import type { TransferIssue } from './blip'

type IncomingFileTransfer = {
	chunks: ArrayBuffer[]
	from: ParticipantId
	mime: string
	name: string
	transferredBytes: number
	size: number
}

/** Chunk and buffer sizes keep large drops responsive without flooding channels. */
const FILE_CHUNK_BYTES = 16 * 1024
const FILE_BUFFER_LOW_BYTES = 512 * 1024

const createIncomingFileTransfer = (
	from: ParticipantId,
	message: Extract<Packet, { type: 'file-start' }>,
): IncomingFileTransfer => {
	return {
		chunks: [],
		from,
		mime: message.mime,
		name: message.name,
		transferredBytes: 0,
		size: message.size,
	}
}

const randomTransferId = () => randomHex(12)

/** File transfers bridge packet chunks and the portrait activity chips people see. */
export type RoomFileTransfers = {
	abortIncomingFrom: (participantId: ParticipantId) => void
	disposeFileUrls: () => void
	handleFileChunk: (message: Extract<Packet, { type: 'file-chunk' }>) => void
	handleFileEnd: (message: Extract<Packet, { type: 'file-end' }>) => void
	handleFileStart: (
		participantId: ParticipantId,
		message: Extract<Packet, { type: 'file-start' }>,
	) => void
	sendFiles: (files: File[]) => Promise<void>
}

/** File transfer state kept outside Solid until bytes become visible activity. */
export const createRoomFileTransfers = (options: {
	openParticipantLinks: () => RoomLink[]
	localParticipantId: () => ParticipantId | null
	markLocalSendingFilesError: () => void
	sendToLinks: (links: RoomLink[], packet: Packet) => number
	setBlipIssue: (issue: TransferIssue | null) => void
	upsertParticipantFile: (
		participantId: ParticipantId,
		nextFile: ParticipantFile,
	) => void
}): RoomFileTransfers => {
	const incomingFiles = new Map<string, IncomingFileTransfer>()
	// Object URLs are browser resources. Keep every one we mint so cleanup is exact.
	let fileUrls = new Set<string>()

	const markIncomingError = (id: string, transfer: IncomingFileTransfer) => {
		options.upsertParticipantFile(transfer.from, {
			id,
			name: transfer.name,
			transferredBytes: transfer.transferredBytes,
			size: transfer.size,
			state: 'error',
			url: null,
		})
		incomingFiles.delete(id)
	}

	const handleFileStart = (
		participantId: ParticipantId,
		message: Extract<Packet, { type: 'file-start' }>,
	) => {
		// Start creates both the byte bucket and the visible receiving chip.
		const transfer = createIncomingFileTransfer(participantId, message)

		incomingFiles.set(message.id, transfer)
		options.upsertParticipantFile(participantId, {
			id: message.id,
			name: message.name,
			transferredBytes: 0,
			size: message.size,
			state: 'receiving',
			url: null,
		})
	}

	const handleFileChunk = (
		message: Extract<Packet, { type: 'file-chunk' }>,
	) => {
		// Chunks can outlive their sender; unknown ids are just stale packets.
		const transfer = incomingFiles.get(message.id)
		if (transfer == null) return

		let bytes: Uint8Array
		try {
			bytes = base64ToBytes(message.data)
		} catch (error) {
			log('warn', 'room', 'file.chunk.decode.failed', { error, id: message.id })
			markIncomingError(message.id, transfer)
			return
		}

		if (transfer.transferredBytes + bytes.byteLength > transfer.size) {
			log('warn', 'room', 'file.chunk.too-large', {
				chunkBytes: bytes.byteLength,
				id: message.id,
				transferredBytes: transfer.transferredBytes,
				size: transfer.size,
			})
			markIncomingError(message.id, transfer)
			return
		}

		const chunk = new Uint8Array(new ArrayBuffer(bytes.byteLength))
		chunk.set(bytes)
		transfer.chunks.push(chunk.buffer)
		transfer.transferredBytes += bytes.byteLength
		options.upsertParticipantFile(transfer.from, {
			id: message.id,
			name: transfer.name,
			transferredBytes: Math.min(transfer.transferredBytes, transfer.size),
			size: transfer.size,
			state: 'receiving',
			url: null,
		})
	}

	const handleFileEnd = (message: Extract<Packet, { type: 'file-end' }>) => {
		// Only at the end do bytes become a downloadable browser URL.
		const transfer = incomingFiles.get(message.id)
		if (transfer == null) return

		const blob = new Blob(transfer.chunks, {
			type: transfer.mime || 'application/octet-stream',
		})
		if (blob.size !== transfer.size) {
			log('warn', 'room', 'file.end.size-mismatch', {
				actual: blob.size,
				expected: transfer.size,
				id: message.id,
			})
			transfer.transferredBytes = blob.size
			markIncomingError(message.id, transfer)
			return
		}

		const url = URL.createObjectURL(blob)
		fileUrls.add(url)
		incomingFiles.delete(message.id)
		options.upsertParticipantFile(transfer.from, {
			id: message.id,
			name: transfer.name,
			transferredBytes: blob.size,
			size: transfer.size,
			state: 'ready',
			url,
		})
	}

	const sendFileToPeers = async (file: File, peers: RoomLink[]) => {
		// File flow: choose recipients at drop time, then show local progress from bytes sent.
		const id = randomTransferId()
		const localParticipantId = options.localParticipantId()

		if (localParticipantId == null) return

		// File chips appear immediately; transfer is best understood as a promise already in motion.
		options.upsertParticipantFile(localParticipantId, {
			id,
			name: file.name,
			transferredBytes: 0,
			size: file.size,
			state: 'sending',
			url: null,
		})
		options.setBlipIssue(null)

		let partiallyDelivered = false
		const sendFilePacket = (packet: Packet, event: string) => {
			const sent = options.sendToLinks(peers, packet)
			if (sent !== peers.length) {
				partiallyDelivered = true
				log('warn', 'room', event, {
					id,
					sent,
					targets: peers.length,
				})
			}
			if (sent === 0) throw new Error('File channel closed')
		}

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

			options.upsertParticipantFile(localParticipantId, {
				id,
				name: file.name,
				transferredBytes: offset + bytes.byteLength,
				size: file.size,
				state: 'sending',
				url: null,
			})
			await Promise.all(
				peers.map((link) => link.rtc.waitForBufferBelow(FILE_BUFFER_LOW_BYTES)),
			)
		}

		sendFilePacket({ id, type: 'file-end' }, 'file.end.partial-send')
		if (partiallyDelivered) {
			options.setBlipIssue('partial-delivery')
		}
		options.upsertParticipantFile(localParticipantId, {
			id,
			name: file.name,
			transferredBytes: file.size,
			size: file.size,
			state: 'ready',
			url: null,
		})
	}

	const sendFiles = async (files: File[]) => {
		// Drops without peers become composer feedback, not hidden work.
		if (files.length === 0) return

		const peers = options.openParticipantLinks()
		if (peers.length === 0) {
			options.setBlipIssue('no-peers')
			return
		}

		try {
			for (const file of files) {
				await sendFileToPeers(file, peers)
			}
		} catch (error) {
			log('warn', 'room', 'file.send.failed', { error })
			options.markLocalSendingFilesError()
			options.setBlipIssue('stopped')
		}
	}

	const abortIncomingFrom = (participantId: ParticipantId) => {
		for (const [id, transfer] of incomingFiles) {
			if (transfer.from !== participantId) continue

			log('warn', 'room', 'file.receive.aborted', {
				id,
				participantId,
				reason: 'peer-left',
			})
			markIncomingError(id, transfer)
		}
	}

	const disposeFileUrls = () => {
		// Download links are cheap to show but not free to keep.
		for (const url of fileUrls) {
			URL.revokeObjectURL(url)
		}

		fileUrls = new Set()
	}

	return {
		abortIncomingFrom,
		disposeFileUrls,
		handleFileChunk,
		handleFileEnd,
		handleFileStart,
		sendFiles,
	}
}
