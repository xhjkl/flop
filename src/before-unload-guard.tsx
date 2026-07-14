import { createEffect, onCleanup } from 'solid-js'
import type { RoomHandle } from './room'
import { isBusyParticipantFile } from './room/participant'

const hasBusyFiles = (room: RoomHandle) => {
	if (room.selfActivity().files.some(isBusyParticipantFile)) return true

	return room
		.peers()
		.some((peer) => peer.activity.files.some(isBusyParticipantFile))
}

const shouldWarnBeforeUnload = (room: RoomHandle) => {
	const entry = room.state.entry

	// A refresh is cheap until a real peer, code, or file is on the line.
	return (
		(entry.side === 'guest' &&
			(entry.status === 'creating-reply' ||
				entry.status === 'reply-ready' ||
				entry.status === 'connected')) ||
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
