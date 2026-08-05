import assert from 'node:assert/strict'
import test from 'node:test'
import { RELAY_GRANT_BYTES } from '../contracts/relay'
import { parseSignalExchangeId } from '../contracts/signal'
import type { RoomConnection } from '../src/room/link'
import { createRoomRelay, type RelayMetering } from '../src/room/relay'

const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

const flushTasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test('a replaced relay session cannot publish late stats', async () => {
	const exchangeId = parseSignalExchangeId('relay-test-mesh-0001')
	assert.ok(exchangeId != null)
	const firstStats = deferred<number | null>()
	const secondStats = deferred<number | null>()
	let sample = 0
	const connection: RoomConnection = {
		connected: true,
		mediaPresence: null,
		mediaStream: null,
		origin: { exchangeId, kind: 'mesh' },
		rtc: {
			acceptAnswer: async () => {},
			close: () => {},
			createAnswer: async () => ({ sdp: '', type: 'answer' }),
			createOffer: async () => ({ sdp: '', type: 'offer' }),
			relayBytes: () =>
				sample++ === 0 ? firstStats.promise : secondStats.promise,
			setLocalMedia: () => {},
			trySend: () => false,
			waitForBufferBelow: async () => {},
		},
	}
	const metering: Array<RelayMetering | null> = []
	let expirations = 0
	const relay = createRoomRelay({
		connections: () => [connection],
		onStatsError: () => assert.fail('unexpected stats error'),
		setMetering: (next) => metering.push(next),
	})

	try {
		relay.start([], () => expirations++)
		relay.start([], () => expirations++)

		firstStats.resolve(RELAY_GRANT_BYTES)
		await flushTasks()
		assert.equal(expirations, 0)
		assert.equal(
			metering.some((value) => value?.bytesLeft === 0),
			false,
		)

		secondStats.resolve(1)
		await flushTasks()
		assert.equal(metering.at(-1)?.bytesLeft, RELAY_GRANT_BYTES - 1)
	} finally {
		relay.clear()
	}
})
