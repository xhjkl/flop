import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decodePacket, encodePacket, type Packet } from '../src/protocol'

describe('room packet contract', () => {
	test('keeps hexadecimal file ids as file ids', () => {
		assert.deepEqual(
			decodePacket(
				JSON.stringify({
					id: 'deadbeef',
					mime: 'text/plain',
					name: 'note.txt',
					size: 4,
					type: 'file-start',
				}),
			),
			{
				id: 'deadbeef',
				mime: 'text/plain',
				name: 'note.txt',
				size: 4,
				type: 'file-start',
			},
		)
	})

	test('rejects an answer carried as a peer offer', () => {
		assert.equal(
			decodePacket(
				JSON.stringify({
					from: '0000000000000001',
					signal: { sdp: 'answer-sdp', type: 'answer' },
					to: '0000000000000002',
					type: 'peer-offer',
				}),
			),
			null,
		)
	})

	test('round trips canonical participant ids', () => {
		const packet: Packet = {
			hostId: 1n,
			roster: [{ id: 1n }, { id: 2n }],
			selfId: 2n,
			type: 'welcome',
		}

		assert.deepEqual(decodePacket(encodePacket(packet)), packet)
	})

	test('rejects non-canonical participant ids', () => {
		assert.equal(
			decodePacket(
				JSON.stringify({
					id: '1',
					type: 'peer-left',
				}),
			),
			null,
		)
	})
})
