import { BeforeUnloadGuard } from './before-unload-guard'
import { FileDropGuard } from './file-drop-guard'
import { createRoom, type RoomHandle } from './room'
import { RoomView } from './room-view'
import { isBusyPortraitFile } from './state'
import './app.css'

const hasBusyFiles = (room: RoomHandle) => {
	if (room.selfActivity().files.some(isBusyPortraitFile)) return true

	return room
		.peers()
		.some((peer) => peer.activity.files.some(isBusyPortraitFile))
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
		room.peers().some((peer) => peer.connectionState === 'live')
	)
}

const App = () => {
	const room = createRoom()

	return (
		<>
			<BeforeUnloadGuard when={shouldWarnBeforeUnload(room)} />
			<FileDropGuard onDropFiles={room.actions.sendFiles} />
			<RoomView hostInviteMode={null} room={room} />
		</>
	)
}

export default App
