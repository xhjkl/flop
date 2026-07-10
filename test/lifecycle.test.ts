import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoot } from 'solid-js'
import { deriveRoomKeys } from '../src/rendezvous/crypto'
import { randomRoomSecret } from '../src/rendezvous/secret'
import { createRoomLifecycle } from '../src/room/lifecycle'
import { createRoomRuntime } from '../src/room/runtime'

test('disposing a room invalidates pending signaling work', async () => {
	const roomSecret = randomRoomSecret()
	const roomKeys = await deriveRoomKeys(roomSecret)

	createRoot((dispose) => {
		try {
			let beaconStops = 0
			const room = createRoomRuntime({
				linkEvents: {
					onClose: () => {},
					onMessage: () => {},
					onOpen: () => {},
				},
			})
			room.signalingVersion = 4
			room.roomSecret = roomSecret
			room.roomKeys = roomKeys
			room.stopBeaconRendezvous = () => beaconStops++

			createRoomLifecycle(room).disposeRoom()

			assert.equal(room.signalingVersion, 5)
			assert.equal(room.roomSecret, null)
			assert.equal(room.roomKeys, null)
			assert.equal(beaconStops, 1)
		} finally {
			dispose()
		}
	})
})
