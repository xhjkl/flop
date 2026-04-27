import { BeforeUnloadGuard } from './before-unload-guard'
import { FileDropGuard } from './file-drop-guard'
import { createRoom, type RoomHandle } from './room'
import { RoomView } from './room-view'
import type { PortraitFileState } from './state'
import './app.css'

const hasBusyFile = (files: PortraitFileState[]) => {
	return files.some(
		(file) => file.state === 'sending' || file.state === 'receiving',
	)
}

const hasBusyFiles = (room: RoomHandle) => {
	if (hasBusyFile(room.selfActivity().files)) return true

	return room.peers().some((peer) => hasBusyFile(peer.activity.files))
}

const shouldWarnBeforeUnload = (room: RoomHandle) => {
	const state = room.state
	const connection = state.connection
	// A refresh is cheap until a real peer, code, or file is on the line.
	return (
		(connection.side === 'guest' &&
			(connection.status === 'creating-reply' ||
				connection.status === 'reply-ready' ||
				connection.status === 'connected')) ||
		hasBusyFiles(room) ||
		room.peers().some((peer) => peer.state === 'live')
	)
}

const App = () => {
	const room = createRoom()

	return (
		<>
			<BeforeUnloadGuard when={shouldWarnBeforeUnload(room)} />
			<FileDropGuard onDropFiles={room.actions.sendFiles} />
			<RoomView room={room} />
		</>
	)
}

export default App
