import { BeforeUnloadGuard } from './before-unload-guard'
import { FileDropGuard } from './file-drop-guard'
import { createRoom } from './room'
import { RoomView } from './room-view'
import './app.css'

const App = () => {
	const room = createRoom()

	return (
		<>
			<BeforeUnloadGuard room={room} />
			<FileDropGuard onDropFiles={room.actions.sendFiles} />
			<RoomView hostInviteMode={null} room={room} />
		</>
	)
}

export default App
