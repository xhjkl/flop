import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
	decodePacket,
	encodePacket,
	type Packet,
	parseParticipantId,
} from '../src/protocol'

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

	test('accepts either SDP direction in one peer signal envelope', () => {
		assert.equal(
			decodePacket(
				JSON.stringify({
					exchangeId: 'mesh-contract-id-001',
					from: '0000000000000001',
					signal: { sdp: 'answer-sdp', type: 'answer' },
					to: '0000000000000002',
					type: 'peer-signal',
				}),
			)?.type,
			'peer-signal',
		)
	})

	test('round trips canonical participant ids', () => {
		const hostId = parseParticipantId('0000000000000001')
		const selfId = parseParticipantId('0000000000000002')
		assert.ok(hostId != null)
		assert.ok(selfId != null)
		const packet: Packet = {
			hostId,
			roster: [hostId, selfId],
			selfId,
			type: 'welcome',
		}

		assert.deepEqual(decodePacket(encodePacket(packet)), packet)
	})

	test('rejects duplicate or self-hosted guest membership', () => {
		assert.equal(
			decodePacket(
				JSON.stringify({
					hostId: '0000000000000001',
					roster: ['0000000000000001', '0000000000000001'],
					selfId: '0000000000000002',
					type: 'welcome',
				}),
			),
			null,
		)
		assert.equal(
			decodePacket(
				JSON.stringify({
					hostId: '0000000000000001',
					roster: ['0000000000000001'],
					selfId: '0000000000000001',
					type: 'welcome',
				}),
			),
			null,
		)
	})

	test('rejects non-canonical participant ids in mesh signals', () => {
		assert.equal(
			decodePacket(
				JSON.stringify({
					exchangeId: 'mesh-contract-id-002',
					from: '1',
					signal: { sdp: 'offer-sdp', type: 'offer' },
					to: '0000000000000002',
					type: 'peer-signal',
				}),
			),
			null,
		)
	})
})
