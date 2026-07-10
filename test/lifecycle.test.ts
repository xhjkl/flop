import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoomLifecycle } from '../src/room/lifecycle'
import type { RoomRuntime } from '../src/room/runtime'

test('disposing a room invalidates pending signaling work', () => {
	let signalingVersion = 4
	let beaconStops = 0
	const room = {
		blips: {},
		closeAllLinks: () => {},
		fileTransfers: { disposeFileUrls: () => {} },
		media: { disposeSelfMedia: () => {} },
		nextSignalingVersion: () => ++signalingVersion,
		relay: { clear: () => {} },
		roomKeys: { encryptionKey: {} },
		roomSecret: 'active-secret',
		stopBeaconRendezvous: () => beaconStops++,
	} as unknown as RoomRuntime

	createRoomLifecycle(room).disposeRoom()

	assert.equal(signalingVersion, 5)
	assert.equal(room.roomSecret, null)
	assert.equal(room.roomKeys, null)
	assert.equal(beaconStops, 1)
})
