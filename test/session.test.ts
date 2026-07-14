import assert from 'node:assert/strict'
import test from 'node:test'
import { createRoot } from 'solid-js'
import { encodePacket, parseParticipantId } from '../src/protocol'
import type { GuestFlow } from '../src/room/entry/guest'
import type { HostFlow } from '../src/room/entry/host'
import { createRoomLifecycle } from '../src/room/lifecycle'
import type { RoomLink } from '../src/room/link'
import { createRoomLinkEvents } from '../src/room/link-events'
import { createRoomSession, type RoomSession } from '../src/room/session'
import type { RtcPeer } from '../src/webrtc'

const fakeRtc = (): RtcPeer => ({
	acceptAnswer: async () => {
		throw new Error('Not implemented by link routing test')
	},
	close: () => {},
	createAnswer: async () => {
		throw new Error('Not implemented by link routing test')
	},
	createOffer: async () => {
		throw new Error('Not implemented by link routing test')
	},
	relayStats: async () => null,
	setLocalMedia: () => {},
	trySend: () => false,
	waitForBufferBelow: async () => {},
})

const addParticipantLink = (
	room: RoomSession,
	id: string,
	participantId: NonNullable<ReturnType<typeof parseParticipantId>>,
	via: 'admission' | 'mesh',
) => {
	const link: RoomLink = {
		channelOpen: true,
		id,
		media: null,
		purpose: { kind: 'participant', participantId, via },
		rtc: fakeRtc(),
	}
	room.links.records.set(link.id, link)
	return link
}

test('room session exposes cohesive ledgers and services', () => {
	createRoot((dispose) => {
		try {
			const room = createRoomSession()

			assert.equal(typeof room.auth.handleAuthPacket, 'function')
			assert.equal(typeof room.blips.send, 'function')
			assert.equal(typeof room.files.sendFiles, 'function')
			assert.equal(typeof room.media.enableSelfMedia, 'function')
			assert.equal(typeof room.mesh.startMissingOffers, 'function')
			assert.equal(room.participants.roster().length, 1)
			assert.equal(typeof room.links.bind, 'function')
		} finally {
			dispose()
		}
	})
})

test('promoted admission links keep their host or guest packet owner', () => {
	createRoot((dispose) => {
		try {
			const room = createRoomSession()
			const lifecycle = createRoomLifecycle(room)
			const hostId = room.session.selfId
			const guestId = parseParticipantId('0000000000000002')
			assert.ok(hostId != null)
			assert.ok(guestId != null)

			let commonMessages = 0
			let guestMessages = 0
			let hostMessages = 0
			room.packets.handleCommon = () => {
				commonMessages++
				return true
			}
			const host: HostFlow = {
				acceptReply: async () => {},
				handleHostPacket: () => true,
				handleHostRendezvousMessage: () => hostMessages++,
				startInviteAsHost: async () => {},
			}
			const guest: GuestFlow = {
				becomeGuest: () => {},
				canClaimFindingInviteLink: () => false,
				claimInviteLinkAsHost: () => {},
				createReply: async () => {},
				handleGuestMessage: () => guestMessages++,
				joinRoomWithInviteLink: () => {},
				tryRelay: async () => {},
			}
			const events = createRoomLinkEvents(room, lifecycle, host, guest)
			const packet = encodePacket({ roster: [], type: 'roster' })

			const admittedGuest = addParticipantLink(
				room,
				'admitted-guest',
				guestId,
				'admission',
			)
			events.onMessage(admittedGuest.id, packet)
			assert.deepEqual(
				{ commonMessages, guestMessages, hostMessages },
				{ commonMessages: 0, guestMessages: 0, hostMessages: 1 },
			)

			room.session.selfId = guestId
			room.session.hostId = hostId
			const admittedHost = addParticipantLink(
				room,
				'admitted-host',
				hostId,
				'admission',
			)
			events.onMessage(admittedHost.id, packet)
			assert.deepEqual(
				{ commonMessages, guestMessages, hostMessages },
				{ commonMessages: 0, guestMessages: 1, hostMessages: 1 },
			)

			const meshGuest = addParticipantLink(room, 'mesh-guest', guestId, 'mesh')
			events.onMessage(meshGuest.id, packet)
			assert.deepEqual(
				{ commonMessages, guestMessages, hostMessages },
				{ commonMessages: 1, guestMessages: 1, hostMessages: 1 },
			)
		} finally {
			dispose()
		}
	})
})
