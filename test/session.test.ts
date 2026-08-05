import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemo, createRoot, mapArray, onCleanup } from 'solid-js'
import {
	type OfferDescription,
	parseSignalExchangeId,
} from '../contracts/signal'
import { encodePacket, parseParticipantId } from '../src/protocol'
import type { GuestFlow } from '../src/room/entry/guest'
import type { HostFlow } from '../src/room/entry/host'
import { createRoomLinkEvents } from '../src/room/link-events'
import { selfMediaDeviceTrack } from '../src/room/media'
import { createRoomSession } from '../src/room/session'
import type { RtcPeer, RtcPeerOptions } from '../src/webrtc'

const participantId = (value: string) => {
	const id = parseParticipantId(value)
	assert.ok(id != null)
	return id
}

const fakeRtcHarness = (send = false) => {
	const closed: RtcPeer[] = []
	const localMedia = new Map<RtcPeer, (MediaStream | null)[]>()
	const create = (_options: RtcPeerOptions) => {
		let isClosed = false
		const rtc: RtcPeer = {
			acceptAnswer: async () => {},
			close: () => {
				isClosed = true
				closed.push(rtc)
			},
			createAnswer: async () => ({ sdp: '', type: 'answer' }),
			createOffer: async () => ({ sdp: '', type: 'offer' }),
			relayBytes: async () => null,
			setLocalMedia: (stream) => localMedia.get(rtc)?.push(stream),
			trySend: () => send && !isClosed,
			waitForBufferBelow: async () => {},
		}
		localMedia.set(rtc, [])
		return rtc
	}
	return { closed, create, localMedia }
}

class FakeMediaTrack {
	enabled = true
	readyState: MediaStreamTrackState = 'live'
	private readonly endedListeners = new Set<() => void>()

	constructor(readonly kind: 'audio' | 'video') {}

	addEventListener(type: string, listener: () => void) {
		if (type === 'ended') this.endedListeners.add(listener)
	}

	end() {
		this.readyState = 'ended'
		for (const listener of this.endedListeners) listener()
	}

	removeEventListener(type: string, listener: () => void) {
		if (type === 'ended') this.endedListeners.delete(listener)
	}

	stop() {
		this.readyState = 'ended'
	}
}

class FakeMediaStream {
	constructor(private readonly tracks: FakeMediaTrack[] = []) {}

	addTrack(track: FakeMediaTrack) {
		this.tracks.push(track)
	}

	getAudioTracks() {
		return this.tracks.filter((track) => track.kind === 'audio')
	}

	getTracks() {
		return [...this.tracks]
	}

	getVideoTracks() {
		return this.tracks.filter((track) => track.kind === 'video')
	}

	removeTrack(track: FakeMediaTrack) {
		const index = this.tracks.indexOf(track)
		if (index !== -1) this.tracks.splice(index, 1)
	}
}

const withFakeDeviceCapture = async (
	task: (tracks: {
		camera: FakeMediaTrack
		microphone: FakeMediaTrack
	}) => Promise<void>,
) => {
	const mediaStream = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream')
	const mediaDevices = Object.getOwnPropertyDescriptor(
		navigator,
		'mediaDevices',
	)
	const microphone = new FakeMediaTrack('audio')
	const camera = new FakeMediaTrack('video')
	const deviceStream = new FakeMediaStream([microphone, camera])
	Object.defineProperty(globalThis, 'MediaStream', {
		configurable: true,
		value: FakeMediaStream,
	})
	Object.defineProperty(navigator, 'mediaDevices', {
		configurable: true,
		value: { getUserMedia: async () => deviceStream },
	})

	try {
		await task({ camera, microphone })
	} finally {
		if (mediaStream == null) Reflect.deleteProperty(globalThis, 'MediaStream')
		else Object.defineProperty(globalThis, 'MediaStream', mediaStream)
		if (mediaDevices == null) Reflect.deleteProperty(navigator, 'mediaDevices')
		else Object.defineProperty(navigator, 'mediaDevices', mediaDevices)
	}
}

const hostFlow = (
	options: { onMessage?: () => void; onRestart?: () => void } = {},
): HostFlow => ({
	acceptReplyCode: async () => {},
	handleMessage: () => options.onMessage?.(),
	refreshManualInvite: async () => options.onRestart?.(),
	startRoom: async () => {},
})

const guestFlow = (onMessage: () => void = () => {}): GuestFlow => ({
	becomeGuest: () => {},
	canClaimInviteAsHost: () => false,
	claimInviteLinkAsHost: () => {},
	joinInvite: async () => {},
	handleMessage: onMessage,
	joinRoomWithInviteLink: () => {},
	tryRelay: async () => {},
})

test('starting a host room releases the old room and local activity', () => {
	createRoot((dispose) => {
		const rtc = fakeRtcHarness()
		const room = createRoomSession(rtc.create)
		const peerId = participantId('0000000000000002')

		try {
			room.setBlipDraft('carry this forward')
			room.sendBlip()
			room.peers.add(peerId)
			const assigned = room.connections.createAdmission({
				kind: 'manual',
				localRole: 'host',
			})
			assert.equal(room.connections.assign(assigned, peerId), true)

			const attempt = room.rendezvous.start('host', null)
			const admission = room.connections.createAdmission({
				kind: 'manual',
				localRole: 'host',
			})
			room.resetForHosting()

			assert.equal(attempt.signal.aborted, true)
			assert.deepEqual(room.peers.all(), [])
			assert.equal(room.self.blip, null)
			assert.equal(room.self.files.length, 0)
			assert.equal(rtc.closed.includes(admission.rtc), true)
			assert.equal(rtc.closed.includes(assigned.rtc), true)
			const identity = room.identity()
			assert.ok(identity != null)
			assert.equal(identity.selfId, identity.hostId)
		} finally {
			room.dispose()
			dispose()
		}
	})
})

test('joining another room preserves the visible committed blip', () => {
	createRoot((dispose) => {
		const room = createRoomSession(fakeRtcHarness().create)
		try {
			room.setBlipDraft('still me')
			room.sendBlip()

			room.resetForJoining({ preserveBlip: true })

			assert.equal(room.self.blip, 'still me')
			assert.equal(room.self.blipDraft, 'still me')
		} finally {
			room.dispose()
			dispose()
		}
	})
})

test('closing a room clears its identity and roster', () => {
	createRoot((dispose) => {
		const room = createRoomSession(fakeRtcHarness().create)
		const peerId = participantId('0000000000000002')

		try {
			room.peers.add(peerId)
			assert.equal(room.localRoomRole(), 'host')
			assert.deepEqual(room.roster(), [room.identity()?.selfId, peerId])

			room.closeRoom()

			assert.equal(room.identity(), null)
			assert.equal(room.localRoomRole(), null)
			assert.deepEqual(room.roster(), [])
			assert.deepEqual(room.peers.all(), [])
		} finally {
			room.dispose()
			dispose()
		}
	})
})

test('an admission receives local media only after participant assignment', async () => {
	await withFakeDeviceCapture(async ({ camera }) => {
		let dispose = () => {}
		const rtc = fakeRtcHarness()
		const room = createRoot((disposeRoot) => {
			dispose = disposeRoot
			return createRoomSession(rtc.create)
		})
		const peerId = participantId('0000000000000002')

		try {
			await room.media.enable()
			assert.equal(room.self.media.status, 'live')
			if (room.self.media.status !== 'live') return
			const publishedStream = room.self.media.publishedStream

			const admission = room.connections.createAdmission({
				kind: 'manual',
				localRole: 'host',
			})
			assert.deepEqual(rtc.localMedia.get(admission.rtc), [null])

			room.peers.add(peerId)
			assert.equal(room.connections.assign(admission, peerId), true)
			assert.deepEqual(rtc.localMedia.get(admission.rtc), [
				null,
				publishedStream,
			])

			camera.end()
			assert.equal(room.self.media.status, 'interrupted')
			assert.deepEqual(rtc.localMedia.get(admission.rtc), [
				null,
				publishedStream,
				null,
			])
		} finally {
			room.dispose()
			dispose()
		}
	})
})

test('camera and microphone toggles update reactive media state', async () => {
	await withFakeDeviceCapture(async () => {
		let dispose = () => {}
		const observed = createRoot((disposeRoot) => {
			dispose = disposeRoot
			const room = createRoomSession(fakeRtcHarness().create)
			return {
				cameraEnabled: createMemo(
					() =>
						selfMediaDeviceTrack(room.self.media, 'video')?.enabled === true,
				),
				microphoneEnabled: createMemo(
					() =>
						selfMediaDeviceTrack(room.self.media, 'audio')?.enabled === true,
				),
				room,
			}
		})

		try {
			await observed.room.media.enable()
			assert.equal(observed.cameraEnabled(), true)
			assert.equal(observed.microphoneEnabled(), true)

			observed.room.media.toggleCamera()
			assert.equal(observed.cameraEnabled(), false)
			assert.equal(observed.microphoneEnabled(), true)

			observed.room.media.toggleMicrophone()
			assert.equal(observed.microphoneEnabled(), false)

			observed.room.media.toggleCamera()
			assert.equal(observed.cameraEnabled(), true)
			assert.equal(observed.microphoneEnabled(), false)

			observed.room.media.toggleMicrophone()
			assert.equal(observed.microphoneEnabled(), true)
		} finally {
			observed.room.dispose()
			dispose()
		}
	})
})

test('admissions and connection replacement keep peer rows mounted', () => {
	createRoot((dispose) => {
		try {
			const rtc = fakeRtcHarness()
			const room = createRoomSession(rtc.create)
			const guestId = participantId('0000000000000002')
			room.peers.add(guestId)

			let mounts = 0
			let cleanups = 0
			const renderedPeerIds = mapArray(room.peers.all, (peer) => {
				mounts++
				onCleanup(() => cleanups++)
				return peer.id
			})
			assert.deepEqual(renderedPeerIds(), [guestId])
			const peerRow = room.peers.byId(guestId)
			const selfId = room.identity()?.selfId
			assert.ok(peerRow != null)
			assert.ok(selfId != null)
			room.peers.replaceRoster([selfId, guestId])
			assert.strictEqual(room.peers.byId(guestId), peerRow)
			assert.deepEqual({ cleanups, mounts }, { cleanups: 0, mounts: 1 })

			const admission = room.connections.createAdmission({
				kind: 'manual',
				localRole: 'guest',
			})
			assert.deepEqual(
				room.peers.all().map((peer) => peer.id),
				[guestId],
			)
			room.connections.close(admission)
			assert.deepEqual(
				room.peers.all().map((peer) => peer.id),
				[guestId],
			)

			const first = room.connections.createAdmission({
				kind: 'manual',
				localRole: 'host',
			})
			assert.equal(room.connections.assign(first, guestId), true)
			first.connected = true
			assert.equal(
				room.packets.handleActivity(guestId, {
					id: 'interrupted-transfer',
					mime: 'text/plain',
					name: 'partial.txt',
					size: 10,
					type: 'file-start',
				}),
				true,
			)
			assert.equal(room.peers.byId(guestId)?.files[0]?.state, 'receiving')

			const replacement = room.connections.createAdmission({
				kind: 'manual',
				localRole: 'host',
			})
			assert.equal(room.connections.assign(replacement, guestId), true)
			assert.equal(room.peers.byId(guestId)?.files[0]?.state, 'failed')
			assert.equal(rtc.closed.filter((peer) => peer === first.rtc).length, 1)
			assert.strictEqual(room.peers.byId(guestId)?.connection, replacement)

			let restarts = 0
			const events = createRoomLinkEvents(
				room,
				hostFlow({ onRestart: () => restarts++ }),
				guestFlow(),
			)
			events.onClose(first)
			assert.equal(restarts, 0)
			assert.strictEqual(room.peers.byId(guestId)?.connection, replacement)
			assert.deepEqual({ cleanups, mounts }, { cleanups: 0, mounts: 1 })

			room.peers.remove(guestId)
			assert.deepEqual(renderedPeerIds(), [])
			assert.deepEqual({ cleanups, mounts }, { cleanups: 1, mounts: 1 })
		} finally {
			dispose()
		}
	})
})

test('stale file work cannot update a successor with the same participant id', async () => {
	let dispose = () => {}
	const room = createRoot((disposeRoot) => {
		dispose = disposeRoot
		return createRoomSession(fakeRtcHarness(true).create)
	})
	const peerId = participantId('0000000000000002')
	const chunk = Promise.withResolvers<ArrayBuffer>()
	const file = {
		name: 'late.txt',
		size: 1,
		slice: () => ({ arrayBuffer: () => chunk.promise }),
		type: 'text/plain',
	} as unknown as File

	try {
		const originalIdentity = room.identity()
		assert.ok(originalIdentity != null)
		room.peers.add(peerId)
		const connection = room.connections.createAdmission({
			kind: 'manual',
			localRole: 'host',
		})
		assert.equal(room.connections.assign(connection, peerId), true)
		connection.connected = true

		const sending = room.files.sendFiles([file])
		assert.equal(room.self.files[0]?.state, 'sending')
		room.resetForHosting()
		room.setIdentity({
			hostId: originalIdentity.selfId,
			selfId: originalIdentity.selfId,
		})
		chunk.resolve(new Uint8Array([1]).buffer)
		await sending

		assert.equal(room.self.fileTransferIssue, null)
		assert.equal(room.self.files.length, 0)
	} finally {
		room.dispose()
		dispose()
	}
})

test('stale file batches cannot start their next file in a successor room', async () => {
	let dispose = () => {}
	const room = createRoot((disposeRoot) => {
		dispose = disposeRoot
		return createRoomSession(fakeRtcHarness(true).create)
	})
	const peerId = participantId('0000000000000002')
	const file = (name: string, size: number) =>
		({
			name,
			size,
			slice: () => {
				throw new Error('Stale file bytes must not be read')
			},
			type: 'text/plain',
		}) as unknown as File

	try {
		const originalIdentity = room.identity()
		assert.ok(originalIdentity != null)
		room.peers.add(peerId)
		const connection = room.connections.createAdmission({
			kind: 'manual',
			localRole: 'host',
		})
		assert.equal(room.connections.assign(connection, peerId), true)
		connection.connected = true

		const sending = room.files.sendFiles([
			file('already-sent.txt', 0),
			file('must-not-start.txt', 1),
		])
		assert.equal(room.self.files[0]?.state, 'sent')
		room.resetForHosting()
		room.setIdentity({
			hostId: originalIdentity.selfId,
			selfId: originalIdentity.selfId,
		})
		await sending

		assert.equal(room.self.fileTransferIssue, null)
		assert.equal(room.self.files.length, 0)
	} finally {
		room.dispose()
		dispose()
	}
})

test('mesh reset invalidates a late failed offer before it can schedule work', async () => {
	const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		'setTimeout',
	)
	const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		'clearTimeout',
	)
	const timers = new Map<number, () => void>()
	let nextTimer = 0
	Object.defineProperty(globalThis, 'setTimeout', {
		configurable: true,
		value: (handler: () => void) => {
			const timer = ++nextTimer
			timers.set(timer, handler)
			return timer
		},
	})
	Object.defineProperty(globalThis, 'clearTimeout', {
		configurable: true,
		value: (timer: number) => timers.delete(timer),
	})

	let dispose = () => {}
	const offer = Promise.withResolvers<OfferDescription>()
	let connectionsCreated = 0
	const room = createRoot((disposeRoot) => {
		dispose = disposeRoot
		return createRoomSession(() => {
			connectionsCreated++
			return {
				acceptAnswer: async () => {},
				close: () => {},
				createAnswer: async () => ({ sdp: '', type: 'answer' }),
				createOffer: () => offer.promise,
				relayBytes: async () => null,
				setLocalMedia: () => {},
				trySend: () => false,
				waitForBufferBelow: async () => {},
			}
		})
	})

	try {
		const hostId = participantId('0000000000000001')
		const targetId = participantId('0000000000000002')
		const selfId = participantId('0000000000000003')
		room.setIdentity({ hostId, selfId })
		room.peers.add(hostId)
		room.peers.add(targetId)

		room.mesh.connectMissingPeers()
		assert.equal(connectionsCreated, 1)
		assert.equal(timers.size, 1)
		room.resetForJoining()
		assert.equal(timers.size, 0)

		offer.reject(new Error('late offer failure'))
		await Promise.resolve()
		await Promise.resolve()

		assert.equal(timers.size, 0)
		assert.equal(connectionsCreated, 1)
	} finally {
		room.dispose()
		dispose()
		if (setTimeoutDescriptor == null) {
			Reflect.deleteProperty(globalThis, 'setTimeout')
		} else {
			Object.defineProperty(globalThis, 'setTimeout', setTimeoutDescriptor)
		}
		if (clearTimeoutDescriptor == null) {
			Reflect.deleteProperty(globalThis, 'clearTimeout')
		} else {
			Object.defineProperty(globalThis, 'clearTimeout', clearTimeoutDescriptor)
		}
	}
})

test('connection origin keeps rendezvous and mesh packet routing stable', async () => {
	let dispose = () => {}
	const room = createRoot((disposeRoot) => {
		dispose = disposeRoot
		return createRoomSession(fakeRtcHarness(true).create)
	})
	try {
		const hostRoutedId = participantId('0000000000000002')
		const guestRoutedId = participantId('0000000000000003')
		const meshPeerId = participantId('0000000000000006')
		const selfId = participantId('0000000000000005')
		const exchangeId = parseSignalExchangeId('session-mesh-id-001')
		assert.ok(exchangeId != null)
		let guestMessages = 0
		let hostMessages = 0
		const events = createRoomLinkEvents(
			room,
			hostFlow({ onMessage: () => hostMessages++ }),
			guestFlow(() => guestMessages++),
		)

		room.peers.add(hostRoutedId)
		const hostRendezvous = room.connections.createAdmission({
			kind: 'manual',
			localRole: 'host',
		})
		assert.equal(room.connections.assign(hostRendezvous, hostRoutedId), true)
		events.onMessage(
			hostRendezvous,
			encodePacket({ roster: [], type: 'roster' }),
		)

		room.peers.add(guestRoutedId)
		const guestRendezvous = room.connections.createAdmission({
			kind: 'manual',
			localRole: 'guest',
		})
		assert.equal(room.connections.assign(guestRendezvous, guestRoutedId), true)
		events.onMessage(
			guestRendezvous,
			encodePacket({ roster: [], type: 'roster' }),
		)

		room.setIdentity({ hostId: guestRoutedId, selfId })
		events.onOpen(guestRendezvous)
		room.peers.add(meshPeerId)
		await room.mesh.handleSignal({
			exchangeId,
			from: meshPeerId,
			signal: { sdp: '', type: 'offer' },
			to: selfId,
			type: 'peer-signal',
		})
		const mesh = room.peers.byId(meshPeerId)?.connection ?? null
		assert.ok(mesh != null)
		events.onMessage(mesh, encodePacket({ text: 'from mesh', type: 'blip' }))

		assert.deepEqual(
			{
				guestMessages,
				hostMessages,
				meshBlip: room.peers.byId(meshPeerId)?.blip,
			},
			{ guestMessages: 1, hostMessages: 1, meshBlip: 'from mesh' },
		)
	} finally {
		dispose()
	}
})

test('stopping rendezvous aborts and releases every owned resource', async () => {
	await new Promise<void>((resolve, reject) =>
		createRoot((dispose) => {
			const rtc = fakeRtcHarness()
			const room = createRoomSession(rtc.create)
			const attempt = room.rendezvous.start('guest', null)
			let clientCloses = 0
			let timeoutRan = false
			attempt.client = { close: () => clientCloses++ }
			attempt.scheduleTimeout(() => {
				timeoutRan = true
			}, 0)
			const admission = room.connections.createAdmission({
				kind: 'manual',
				localRole: 'guest',
			})

			try {
				room.rendezvous.stop()

				assert.equal(attempt.signal.aborted, true)
				assert.equal(attempt.client, null)
				assert.equal(room.rendezvous.current, null)
				assert.equal(room.connections.isCurrent(admission), false)
				assert.equal(clientCloses, 1)
				assert.equal(
					rtc.closed.filter((peer) => peer === admission.rtc).length,
					1,
				)
				setTimeout(() => {
					try {
						assert.equal(timeoutRan, false)
						resolve()
					} catch (error) {
						reject(error)
					} finally {
						room.dispose()
						dispose()
					}
				}, 5)
			} catch (error) {
				room.dispose()
				dispose()
				reject(error)
			}
		}),
	)
})
