import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoot } from 'solid-js'
import type { ParticipantId } from '../src/protocol'
import { createBeaconFlow } from '../src/room/beacon-flow'
import { createHostFlow } from '../src/room/host'
import { createRoomLifecycle } from '../src/room/lifecycle'
import { createRoomRuntime } from '../src/room/runtime'

test('failed welcome rolls back host admission before broadcasting', () => {
	createRoot((dispose) => {
		try {
			const guestId = 2n
			const removed: ParticipantId[] = []
			let broadcasts = 0
			const room = createRoomRuntime({
				linkEvents: {
					onClose: () => {},
					onMessage: () => {},
					onOpen: () => {},
				},
			})
			const removeParticipant = room.removeParticipant
			room.removeParticipant = (participantId) => {
				removed.push(participantId)
				removeParticipant(participantId)
			}
			room.broadcastMembershipChange = () => broadcasts++
			const lifecycle = createRoomLifecycle(room)
			const beacon = createBeaconFlow(room)
			const flow = createHostFlow(room, lifecycle, beacon)

			assert.equal(flow.handleHostPacket(guestId, { type: 'hello' }), false)
			assert.deepEqual(removed, [guestId])
			assert.equal(broadcasts, 0)
		} finally {
			dispose()
		}
	})
})
