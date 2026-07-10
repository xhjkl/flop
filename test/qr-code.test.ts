import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeQrCode } from '../src/ui/qr-code'

test('QR table and grid invariants hold across correction levels', () => {
	for (const bytes of [1, 64, 512, 1_024, 1_500, 2_500, 2_953]) {
		const qr = encodeQrCode('x'.repeat(bytes))
		if (qr == null) assert.fail(`${bytes} bytes should fit`)
		assert.ok(qr.path.startsWith('M'))
		assert.ok(qr.size >= 21)
	}

	assert.equal(encodeQrCode('x'.repeat(2_954)), null)
})
