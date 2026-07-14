import assert from 'node:assert/strict'
import test from 'node:test'
import { viewfinderObjectPosition } from '../src/viewfinder'

const bounds = { height: 100, left: 10, top: 20, width: 200 }

test('viewfinder maps the card edges and center onto the video crop', () => {
	assert.equal(viewfinderObjectPosition(10, 20, bounds, false), '0% 0%')
	assert.equal(viewfinderObjectPosition(110, 70, bounds, false), '50% 50%')
	assert.equal(viewfinderObjectPosition(210, 120, bounds, false), '100% 100%')
})

test('viewfinder clamps captured pointers outside the card', () => {
	assert.equal(viewfinderObjectPosition(-10, 0, bounds, false), '0% 0%')
	assert.equal(viewfinderObjectPosition(230, 140, bounds, false), '100% 100%')
})

test('viewfinder follows the visible direction of a mirrored preview', () => {
	assert.equal(viewfinderObjectPosition(10, 20, bounds, true), '100% 0%')
	assert.equal(viewfinderObjectPosition(210, 120, bounds, true), '0% 100%')
})
