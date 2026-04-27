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

	return room.peerKeys().some((key) => {
		const peer = room.participant(key)
		return peer != null && hasBusyFile(peer.activity.files)
	})
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
		room.peerKeys().some((key) => room.peer(key)?.state === 'live')
	)
}

const App = () => {
	const room = createRoom()
	const actions = room.actions
	const state = room.state

	return (
		<>
			<BeforeUnloadGuard when={shouldWarnBeforeUnload(room)} />
			<FileDropGuard onDropFiles={actions.sendFiles} />
			<RoomView
				actions={actions}
				blipComposer={state.blipComposer}
				connection={state.connection}
				peers={room.peerKeys().flatMap((key) => {
					const peer = room.peer(key)
					if (peer == null) return []

					return [
						{
							activity: peer.activity,
							colorSeed: peer.id,
							mediaState: peer.mediaState,
							mediaStream: peer.mediaStream,
							state: peer.state,
						},
					]
				})}
				selfActivity={room.selfActivity()}
				selfMedia={state.selfMedia}
				themeSeed={state.themeSeed}
			/>
		</>
	)
}

export default App
