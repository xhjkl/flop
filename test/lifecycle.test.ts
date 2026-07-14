import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoot } from 'solid-js'
import { deriveRoomKeys } from '../src/rendezvous/crypto'
import { randomRoomSecret } from '../src/rendezvous/secret'
import { createRoomLifecycle } from '../src/room/lifecycle'
import { createRoomSession } from '../src/room/session'

test('disposing a room invalidates pending signaling work', async () => {
	const roomSecret = randomRoomSecret()
	const roomKeys = await deriveRoomKeys(roomSecret)

	createRoot((dispose) => {
		try {
			let beaconStops = 0
			const room = createRoomSession()
			room.session.signalingGeneration = 4
			room.session.inviteSecret = roomSecret
			room.session.keys = roomKeys
			room.session.stopBeacon = () => beaconStops++

			createRoomLifecycle(room).disposeRoom()

			assert.equal(room.session.signalingGeneration, 5)
			assert.equal(room.session.inviteSecret, null)
			assert.equal(room.session.keys, null)
			assert.equal(beaconStops, 1)
		} finally {
			dispose()
		}
	})
})
