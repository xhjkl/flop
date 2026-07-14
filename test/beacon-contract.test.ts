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
	test('accepts explicit broadcast and targeted signals', () => {
		assert.deepEqual(decodeClientBeaconMessage({ ...signal, to: null }), {
			...signal,
			to: null,
		})
		assert.deepEqual(
			decodeClientBeaconMessage({ ...signal, to: 'p'.repeat(16) }),
			{ ...signal, to: 'p'.repeat(16) },
		)
	})

	test('rejects missing or malformed signal targets', () => {
		assert.equal(decodeClientBeaconMessage(signal), null)
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
	test('keeps departure identity atomic inside nested presence', () => {
		const message = {
			left: { id: 'p'.repeat(16), role: 'guest' as const },
			presence: { guests: 0, hosts: 1 },
			type: 'presence' as const,
		}

		assert.deepEqual(decodeServerBeaconMessage(message), message)
		assert.equal(
			decodeServerBeaconMessage({
				leftRole: 'guest',
				presence: message.presence,
				type: 'presence',
			}),
			null,
		)
	})
})
