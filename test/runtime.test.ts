import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoot } from 'solid-js'
import { createRoomRuntime } from '../src/room/runtime'

test('room runtime returns with every recursive service bound', () => {
	createRoot((dispose) => {
		try {
			const room = createRoomRuntime({
				linkEvents: {
					onClose: () => {},
					onMessage: () => {},
					onOpen: () => {},
				},
			})

			assert.equal(typeof room.beaconAuth.handleAuthPacket, 'function')
			assert.equal(typeof room.blips.send, 'function')
			assert.equal(typeof room.fileTransfers.sendFiles, 'function')
			assert.equal(typeof room.media.enableSelfMedia, 'function')
			assert.equal(typeof room.mesh.startMissingOffers, 'function')
			assert.equal(room.roomRoster().length, 1)
		} finally {
			dispose()
		}
	})
})
