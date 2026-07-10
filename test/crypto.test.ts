import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
	deriveRoomKeys,
	signRoomAuth,
	verifyRoomAuth,
} from '../src/rendezvous/crypto'
import {
	parseRoomSecret,
	roomSecretBytes,
	roomSecretFromBytes,
} from '../src/rendezvous/secret'

const KNOWN_BYTES = Uint8Array.from({ length: 16 }, (_, index) => index)
// Python's RFC 4648 encoder remapped through Zimmermann's published alphabet.
const KNOWN_SECRET = 'yyyoryarywdyqnyjbefoadeqbh'

describe('room secret contract', () => {
	test('matches the external z-base-32 vector', () => {
		assert.equal(roomSecretFromBytes(KNOWN_BYTES), KNOWN_SECRET)

		const secret = parseRoomSecret(KNOWN_SECRET.toUpperCase())
		if (secret == null) assert.fail('known room secret should parse')
		assert.equal(secret, KNOWN_SECRET)
		assert.deepEqual(roomSecretBytes(secret), KNOWN_BYTES)
	})

	test('rejects noncanonical or incorrectly sized secrets', () => {
		assert.equal(parseRoomSecret(`${KNOWN_SECRET.slice(0, -1)}0`), null)
		assert.equal(parseRoomSecret(KNOWN_SECRET.slice(1)), null)
		assert.throws(() => roomSecretFromBytes(KNOWN_BYTES.slice(1)))
	})
})

describe('room authentication', () => {
	test('verifies only the matching purpose, nonce, key, and MAC', async () => {
		const key = (await deriveRoomKeys(roomSecretFromBytes(KNOWN_BYTES))).authKey
		const otherKey = (
			await deriveRoomKeys(roomSecretFromBytes(new Uint8Array(16).fill(0xff)))
		).authKey
		const nonce = 'guest-nonce'
		const mac = await signRoomAuth(key, 'guest-to-host', nonce)

		assert.equal(await verifyRoomAuth(key, 'guest-to-host', nonce, mac), true)
		assert.equal(await verifyRoomAuth(key, 'host-to-guest', nonce, mac), false)
		assert.equal(
			await verifyRoomAuth(key, 'guest-to-host', 'other', mac),
			false,
		)
		assert.equal(
			await verifyRoomAuth(otherKey, 'guest-to-host', nonce, mac),
			false,
		)
		assert.equal(await verifyRoomAuth(key, 'guest-to-host', nonce, '*'), false)
	})
})
