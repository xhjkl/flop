import { createEffect, createMemo, onSettled } from 'solid-js'
import type { RoomController } from '../room'
import { isFileTransferActive } from '../room/participant'

const shouldWarnBeforeUnload = (room: RoomController) => {
	const entry = room.state.entry
	const joining =
		entry.side === 'guest' &&
		(entry.status === 'creating-reply' ||
			entry.status === 'reply-ready' ||
			entry.status === 'connected')
	const transferring =
		room.self.files.some(isFileTransferActive) ||
		room.peers.all().some((peer) => peer.files.some(isFileTransferActive))
	const connected = room.peers
		.all()
		.some((peer) => peer.connection?.connected === true)

	return joining || transferring || connected
}

/** Window listeners whose behavior depends on the active room. */
export const useRoomWindowEvents = (room: RoomController) => {
	const warnBeforeUnload = createMemo(() => shouldWarnBeforeUnload(room))
	createEffect(warnBeforeUnload, (shouldWarn) => {
		if (!shouldWarn) return

		const warn = (event: BeforeUnloadEvent) => event.preventDefault()
		window.addEventListener('beforeunload', warn)
		return () => window.removeEventListener('beforeunload', warn)
	})

	onSettled(() => {
		const carriesFiles = (event: DragEvent) => {
			return Array.from(event.dataTransfer?.types ?? []).includes('Files')
		}
		const preventBrowserFileOpen = (event: DragEvent) => {
			if (carriesFiles(event)) event.preventDefault()
		}
		const receiveFiles = (event: DragEvent) => {
			if (!carriesFiles(event)) return
			event.preventDefault()
			const files = Array.from(event.dataTransfer?.files ?? [])
			if (files.length > 0) room.commands.sendFiles(files)
		}

		window.addEventListener('dragover', preventBrowserFileOpen)
		window.addEventListener('drop', receiveFiles)
		return () => {
			window.removeEventListener('dragover', preventBrowserFileOpen)
			window.removeEventListener('drop', receiveFiles)
		}
	})
}
