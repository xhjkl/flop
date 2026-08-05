import { useRoom } from './room'
import { RoomView } from './ui/room-view'
import { useRoomWindowEvents } from './ui/window-events'
import './app.css'

const App = () => {
	const room = useRoom()
	useRoomWindowEvents(room)

	return <RoomView room={room} />
}

export default App
