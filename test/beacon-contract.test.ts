import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
	decodeClientBeaconMessage,
	decodeServerBeaconMessage,
} from '../contracts/beacon'

const signal = {
	exchangeId: 'x'.repeat(16),
	signal: { sdp: 'offer-sdp', type: 'offer' as const },
	type: 'signal' as const,
}

describe('beacon client contract', () => {
	test('accepts a signal targeted to one discovery peer', () => {
		assert.deepEqual(
			decodeClientBeaconMessage({ ...signal, to: 'p'.repeat(16) }),
			{ ...signal, to: 'p'.repeat(16) },
		)
	})

	test('rejects broadcast, missing, and malformed signal targets', () => {
		assert.equal(decodeClientBeaconMessage(signal), null)
		assert.equal(decodeClientBeaconMessage({ ...signal, to: null }), null)
		assert.equal(
			decodeClientBeaconMessage({ ...signal, to: 'not a peer id' }),
			null,
		)
	})

	test('accepts an answer in the same signal envelope', () => {
		assert.equal(
			decodeClientBeaconMessage({
				...signal,
				signal: { sdp: 'answer-sdp', type: 'answer' },
				to: 'p'.repeat(16),
			})?.type,
			'signal',
		)
	})
})

describe('beacon server contract', () => {
	test('accepts one complete, uniquely identified peer snapshot', () => {
		const message = {
			peers: [
				{ id: 'g'.repeat(16), role: 'guest' as const },
				{ id: 'h'.repeat(16), role: 'host' as const },
			],
			type: 'peers' as const,
		}

		assert.deepEqual(decodeServerBeaconMessage(message), message)
		assert.equal(
			decodeServerBeaconMessage({
				peers: [message.peers[0], message.peers[0]],
				type: 'peers',
			}),
			null,
		)
	})
})
