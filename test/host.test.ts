import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoot } from 'solid-js'
import { type ParticipantId, parseParticipantId } from '../src/protocol'
import { createBeaconFlow } from '../src/room/entry/beacon'
import { createHostFlow } from '../src/room/entry/host'
import { createRoomLifecycle } from '../src/room/lifecycle'
import { createRoomSession } from '../src/room/session'

test('failed welcome rolls back host admission before broadcasting', () => {
	createRoot((dispose) => {
		try {
			const guestId = parseParticipantId('0000000000000002')
			assert.ok(guestId != null)
			const removed: ParticipantId[] = []
			let broadcasts = 0
			const room = createRoomSession()
			const removeParticipant = room.participants.remove
			room.participants.remove = (participantId) => {
				removed.push(participantId)
				removeParticipant(participantId)
			}
			room.packets.broadcastMembershipChange = () => broadcasts++
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
