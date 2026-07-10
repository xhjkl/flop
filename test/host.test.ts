import assert from 'node:assert/strict'
import test from 'node:test'
import type { ParticipantId } from '../src/protocol'
import type { BeaconFlow } from '../src/room/beacon-flow'
import { createHostFlow } from '../src/room/host'
import type { RoomLifecycle } from '../src/room/lifecycle'
import type { RoomRuntime } from '../src/room/runtime'

test('failed welcome rolls back host admission before broadcasting', () => {
	const guestId = 2n as ParticipantId
	const removed: ParticipantId[] = []
	let broadcasts = 0
	const room = {
		broadcastMembershipChange: () => broadcasts++,
		handleCommonMessage: () => false,
		localParticipantId: 1n as ParticipantId,
		removeParticipant: (participantId: ParticipantId) =>
			removed.push(participantId),
		roomRoster: () => [],
		sendToParticipant: () => false,
	} as unknown as RoomRuntime
	const flow = createHostFlow(room, {} as RoomLifecycle, {} as BeaconFlow)

	assert.equal(flow.handleHostPacket(guestId, { type: 'hello' }), false)
	assert.deepEqual(removed, [guestId])
	assert.equal(broadcasts, 0)
})
