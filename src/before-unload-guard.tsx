import { createEffect, onCleanup } from 'solid-js'
import type { RoomHandle } from './room'
import { isBusyPortraitFile } from './state'

const hasBusyFiles = (room: RoomHandle) => {
	if (room.selfActivity().files.some(isBusyPortraitFile)) return true

	return room
		.peers()
		.some((peer) => peer.activity.files.some(isBusyPortraitFile))
}

const shouldWarnBeforeUnload = (room: RoomHandle) => {
	const connection = room.state.connection

	// A refresh is cheap until a real peer, code, or file is on the line.
	return (
		(connection.side === 'guest' &&
			(connection.status === 'creating-reply' ||
				connection.status === 'reply-ready' ||
				connection.status === 'connected')) ||
		hasBusyFiles(room) ||
		room.peers().some((peer) => peer.connectionState === 'live')
	)
}

export const BeforeUnloadGuard = (props: { room: RoomHandle }) => {
	createEffect(() => {
		if (!shouldWarnBeforeUnload(props.room)) return

		// Browsers will not let us customize the text, so only ask when the interruption is real.
		const warnBeforeUnload = (event: BeforeUnloadEvent) => {
			event.preventDefault()
		}

		window.addEventListener('beforeunload', warnBeforeUnload)
		onCleanup(() => {
			window.removeEventListener('beforeunload', warnBeforeUnload)
		})
	})

	return null
}
