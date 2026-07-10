import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decodeClientBeaconMessage } from '../contracts/beacon'

const offer = {
	offer: { sdp: 'offer-sdp', type: 'offer' as const },
	offerId: 'o'.repeat(16),
	type: 'offer' as const,
}

describe('beacon client contract', () => {
	test('accepts explicit broadcast and targeted offers', () => {
		assert.deepEqual(
			decodeClientBeaconMessage({ ...offer, beaconPeerId: null }),
			{
				...offer,
				beaconPeerId: null,
			},
		)
		assert.deepEqual(
			decodeClientBeaconMessage({ ...offer, beaconPeerId: 'p'.repeat(16) }),
			{ ...offer, beaconPeerId: 'p'.repeat(16) },
		)
	})

	test('rejects missing or malformed offer targets', () => {
		assert.equal(decodeClientBeaconMessage(offer), null)
		assert.equal(
			decodeClientBeaconMessage({ ...offer, beaconPeerId: 'not a peer id' }),
			null,
		)
	})

	test('rejects an answer carried as an offer', () => {
		assert.equal(
			decodeClientBeaconMessage({
				...offer,
				beaconPeerId: null,
				offer: { sdp: 'answer-sdp', type: 'answer' },
			}),
			null,
		)
	})
})
