import { base64ToBytes, bytesToBase64 } from '../binary'
import { log } from '../log'
import {
	type Packet,
	type ParticipantId,
	participantIdToString,
} from '../protocol'
import type { PortraitFileState } from '../state'
import {
	createIncomingFileTransfer,
	FILE_BUFFER_LOW_BYTES,
	FILE_CHUNK_BYTES,
	type IncomingFileTransfer,
	randomTransferId,
} from './activity'
import type { RoomLink } from './link'
import { blipIssueCopy } from './status-copy'

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
	liveParticipantLinks: () => RoomLink[]
	localParticipantId: () => ParticipantId | null
	markLocalSendingFilesError: () => void
	sendToLinks: (links: RoomLink[], packet: Packet) => number
	setBlipIssue: (issue: string | null) => void
	upsertParticipantFile: (
		participantId: ParticipantId,
		nextFile: PortraitFileState,
	) => void
}): RoomFileTransfers => {
	const incomingFiles = new Map<string, IncomingFileTransfer>()
	// Object URLs are browser resources. Keep every one we mint so cleanup is exact.
	let fileUrls = new Set<string>()

	const markIncomingError = (id: string, transfer: IncomingFileTransfer) => {
		options.upsertParticipantFile(transfer.from, {
			id,
			name: transfer.name,
			receivedBytes: transfer.receivedBytes,
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
			receivedBytes: 0,
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

		if (transfer.receivedBytes + bytes.byteLength > transfer.size) {
			log('warn', 'room', 'file.chunk.too-large', {
				chunkBytes: bytes.byteLength,
				id: message.id,
				receivedBytes: transfer.receivedBytes,
				size: transfer.size,
			})
			markIncomingError(message.id, transfer)
			return
		}

		const chunk = new Uint8Array(new ArrayBuffer(bytes.byteLength))
		chunk.set(bytes)
		transfer.chunks.push(chunk.buffer)
		transfer.receivedBytes += bytes.byteLength
		options.upsertParticipantFile(transfer.from, {
			id: message.id,
			name: transfer.name,
			receivedBytes: Math.min(transfer.receivedBytes, transfer.size),
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
			transfer.receivedBytes = blob.size
			markIncomingError(message.id, transfer)
			return
		}

		const url = URL.createObjectURL(blob)
		fileUrls.add(url)
		incomingFiles.delete(message.id)
		options.upsertParticipantFile(transfer.from, {
			id: message.id,
			name: transfer.name,
			receivedBytes: blob.size,
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
			receivedBytes: 0,
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
				receivedBytes: offset + bytes.byteLength,
				size: file.size,
				state: 'sending',
				url: null,
			})
			await Promise.all(
				peers.map((link) =>
					link.peer.waitForBufferBelow(FILE_BUFFER_LOW_BYTES),
				),
			)
		}

		sendFilePacket({ id, type: 'file-end' }, 'file.end.partial-send')
		if (partiallyDelivered) {
			options.setBlipIssue(blipIssueCopy.filePartialDelivery)
		}
		options.upsertParticipantFile(localParticipantId, {
			id,
			name: file.name,
			receivedBytes: file.size,
			size: file.size,
			state: 'ready',
			url: null,
		})
	}

	const sendFiles = async (files: File[]) => {
		// Drops without peers become composer feedback, not hidden work.
		if (files.length === 0) return

		const peers = options.liveParticipantLinks()
		if (peers.length === 0) {
			options.setBlipIssue(blipIssueCopy.fileNoPeers)
			return
		}

		try {
			for (const file of files) {
				await sendFileToPeers(file, peers)
			}
		} catch (error) {
			log('warn', 'room', 'file.send.failed', { error })
			options.markLocalSendingFilesError()
			options.setBlipIssue(blipIssueCopy.fileStopped)
		}
	}

	const abortIncomingFrom = (participantId: ParticipantId) => {
		for (const [id, transfer] of incomingFiles) {
			if (transfer.from !== participantId) continue

			log('warn', 'room', 'file.receive.aborted', {
				id,
				participantId: participantIdToString(participantId),
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
