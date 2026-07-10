import assert from 'node:assert/strict'
import test from 'node:test'
import { RELAY_GRANT_BYTES } from '../contracts/relay'
import { createRoomRelay } from '../src/room/relay'
import type { RelayMetering } from '../src/state'
import type { PeerRelayStats } from '../src/webrtc'

const deferred = <T>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

const flushTasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test('a replaced relay session cannot publish late stats', async () => {
	const firstStats = deferred<PeerRelayStats | null>()
	const secondStats = deferred<PeerRelayStats | null>()
	let sample = 0
	const link = {
		id: 'mesh:1',
		peer: {
			relayStats: () =>
				sample++ === 0 ? firstStats.promise : secondStats.promise,
		},
	}
	const metering: Array<RelayMetering | null> = []
	let expirations = 0
	const relay = createRoomRelay({
		links: new Map([[link.id, link]]),
		onStatsError: () => assert.fail('unexpected stats error'),
		setMetering: (next) => metering.push(next),
	})

	try {
		relay.start([], () => expirations++)
		relay.start([], () => expirations++)

		firstStats.resolve({ bytes: RELAY_GRANT_BYTES })
		await flushTasks()
		assert.equal(expirations, 0)
		assert.equal(
			metering.some((value) => value?.bytesLeft === 0),
			false,
		)

		secondStats.resolve({ bytes: 1 })
		await flushTasks()
		assert.equal(metering.at(-1)?.bytesLeft, RELAY_GRANT_BYTES - 1)
	} finally {
		relay.clear()
	}
})
