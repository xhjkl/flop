import { reconcile } from 'solid-js/store'
import type { RoomSecret } from '../rendezvous/secret'
import { clearProjectedHostInvite } from './address-bar'
import { closedConnection } from './initial-state'
import { mergeParticipant, randomParticipantId } from './participant'
import type { RoomRuntime } from './runtime'

/** Room-level resets and teardown, separated from invite and packet decisions. */
export type RoomLifecycle = {
	disposeRoom: () => void
	markRoomClosed: (options?: { keepRelayMetering?: boolean }) => void
	resetAsHost: (options?: { secret?: RoomSecret | null }) => void
	resetBeforeJoining: (options?: { keepPendingBlip?: boolean }) => void
}

export const createRoomLifecycle = (room: RoomRuntime): RoomLifecycle => {
	const cancelSignaling = () => {
		// Retire every async invite owner before tearing down the resources it can touch.
		room.nextSignalingVersion()
		room.roomSecret = null
		room.roomKeys = null
		room.stopBeaconRendezvous()
	}

	const clearPeerParticipants = () => {
		// When a room ends, keep only the self card's history.
		const local = room.localKey()
		const self = local == null ? null : room.participants[local]
		const participants = local != null && self != null ? { [local]: self } : {}

		room.setParticipants(reconcile(participants))
		room.setParticipantKeys(local == null ? [] : [local])
	}

	const resetAsHost = (options: { secret?: RoomSecret | null } = {}) => {
		// Starting fresh as host makes a new room identity and color.
		room.relay.clear()
		room.stopBeaconRendezvous()
		room.blips.clearPending()
		room.roomSecret = options.secret ?? null
		room.roomKeys = null
		room.localParticipantId = randomParticipantId()
		room.hostParticipantId = room.localParticipantId
		room.closeAllLinks()

		const host = mergeParticipant({ id: room.localParticipantId })
		room.setParticipants(reconcile({ [host.id]: host }))
		room.setParticipantKeys([host.id])
		room.setLocalKey(host.id)
		room.setState('themeSeed', host.id)
	}

	const resetBeforeJoining = (options: { keepPendingBlip?: boolean } = {}) => {
		// Before welcome, a guest has no durable identity in this room.
		clearProjectedHostInvite()
		room.relay.clear()
		room.stopBeaconRendezvous()
		if (!options.keepPendingBlip) room.blips.clearPending()
		room.roomSecret = null
		room.roomKeys = null
		room.localParticipantId = null
		room.hostParticipantId = null
		room.closeAllLinks()
		room.setParticipants(reconcile({}))
		room.setParticipantKeys([])
		room.setLocalKey(null)
	}

	const markRoomClosed = (options: { keepRelayMetering?: boolean } = {}) => {
		// Closed is visible state plus real transport teardown.
		clearProjectedHostInvite()
		cancelSignaling()
		room.relay.clear({ keepMetering: options.keepRelayMetering ?? false })
		room.closeAllLinks()
		clearPeerParticipants()
		room.setState('connection', closedConnection())
	}

	const disposeRoom = () => {
		// Tear down browser resources in the opposite order people see them.
		cancelSignaling()
		room.relay.clear()
		room.closeAllLinks()
		room.fileTransfers.disposeFileUrls()
		room.media.disposeSelfMedia()
	}

	return { disposeRoom, markRoomClosed, resetAsHost, resetBeforeJoining }
}
