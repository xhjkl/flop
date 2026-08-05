import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoot } from 'solid-js'
import { decodePacket, parseParticipantId } from '../src/protocol'
import { createBeaconFlow } from '../src/room/entry/beacon'
import { createHostFlow } from '../src/room/entry/host'
import { createRoomSession } from '../src/room/session'
import type { RtcPeer } from '../src/webrtc'

type FakeRtcBehavior = {
	sendSucceeds: boolean
	sent: string[]
}

const fakeRtc = (behavior: FakeRtcBehavior): RtcPeer => {
	return {
		acceptAnswer: async () => {},
		close: () => {},
		createAnswer: async () => {
			throw new Error('Unexpected answer creation')
		},
		createOffer: async () => {
			throw new Error('Unexpected offer creation')
		},
		relayBytes: async () => null,
		setLocalMedia: () => {},
		trySend: (text) => {
			behavior.sent.push(text)
			return behavior.sendSucceeds
		},
		waitForBufferBelow: async () => {},
	}
}

test('failed welcome removes the admitted peer without broadcasting a roster', async () => {
	const existingSends: string[] = []
	const failedWelcomeSends: string[] = []
	const rtcBehaviors: FakeRtcBehavior[] = [
		{ sendSucceeds: true, sent: existingSends },
		{ sendSucceeds: false, sent: failedWelcomeSends },
	]
	const { dispose, room } = createRoot((dispose) => ({
		dispose,
		room: createRoomSession(() => {
			const behavior = rtcBehaviors.shift()
			assert.ok(behavior != null)
			return fakeRtc(behavior)
		}),
	}))
	try {
		const existingPeerId = parseParticipantId('0000000000000002')
		assert.ok(existingPeerId != null)

		const existingConnection = room.connections.createAdmission({
			kind: 'manual',
			localRole: 'host',
		})
		existingConnection.connected = true
		room.peers.add(existingPeerId)
		assert.equal(
			room.connections.assign(existingConnection, existingPeerId),
			true,
		)

		const failedWelcomeConnection = room.connections.createAdmission({
			kind: 'manual',
			localRole: 'host',
		})
		failedWelcomeConnection.connected = true
		const host = createHostFlow(room, createBeaconFlow(room))
		host.handleMessage(failedWelcomeConnection, { type: 'hello' })
		await Promise.resolve()

		assert.deepEqual(
			room.peers.all().map((peer) => peer.id),
			[existingPeerId],
		)
		assert.equal(room.connections.isCurrent(failedWelcomeConnection), false)
		assert.equal(failedWelcomeConnection.connected, false)
		assert.equal(failedWelcomeSends.length, 1)
		assert.equal(decodePacket(failedWelcomeSends[0])?.type, 'welcome')
		assert.deepEqual(existingSends, [])
	} finally {
		room.dispose()
		dispose()
	}
})
