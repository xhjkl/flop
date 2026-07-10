import assert from 'node:assert/strict'
import test from 'node:test'
import {
	acceptRoomDataChannel,
	ROOM_DATA_CHANNEL_LABEL,
} from '../src/webrtc/channel'
import { connectionHealth } from '../src/webrtc/connection'

const channel = (label: string) => {
	let closed = false
	return {
		channel: {
			close: () => {
				closed = true
			},
			label,
		} as RTCDataChannel,
		closed: () => closed,
	}
}

test('a fatal WebRTC state wins over a stale connected state', () => {
	assert.equal(connectionHealth('failed', 'connected'), 'failed')
	assert.equal(connectionHealth('connected', 'failed'), 'failed')
	assert.equal(connectionHealth('new', 'completed'), 'connected')
})

test('only the first correctly named room data channel is accepted', () => {
	const expected = channel(ROOM_DATA_CHANNEL_LABEL)
	assert.equal(acceptRoomDataChannel(null, expected.channel), true)
	assert.equal(expected.closed(), false)

	const duplicate = channel(ROOM_DATA_CHANNEL_LABEL)
	assert.equal(
		acceptRoomDataChannel(expected.channel, duplicate.channel),
		false,
	)
	assert.equal(duplicate.closed(), true)

	const unexpected = channel('surprise')
	assert.equal(acceptRoomDataChannel(null, unexpected.channel), false)
	assert.equal(unexpected.closed(), true)
})
