import { reconcile } from 'solid-js/store'
import type { RoomSecret } from '../rendezvous/secret'
import { clearProjectedHostInvite } from './address-bar'
import { closedEntry } from './initial-state'
import { mergeParticipant, randomParticipantId } from './participant'
import type { RoomSession } from './session'

/** Room-level resets and teardown, separated from invite and packet decisions. */
export type RoomLifecycle = {
	disposeRoom: () => void
	markRoomClosed: (options?: { keepRelayMetering?: boolean }) => void
	resetAsHost: (options?: { secret?: RoomSecret | null }) => void
	resetBeforeJoining: (options?: { keepPendingBlip?: boolean }) => void
}

export const createRoomLifecycle = (room: RoomSession): RoomLifecycle => {
	const cancelSignaling = () => {
		// Retire every async invite owner before tearing down the resources it can touch.
		room.session.nextSignalingGeneration()
		room.session.inviteSecret = null
		room.session.keys = null
		room.session.stopBeacon()
	}

	const clearPeerParticipants = () => {
		// When a room ends, keep only the self card's history.
		const local = room.session.selfId
		const self = local == null ? null : room.participants.records[local]
		const participants = local != null && self != null ? { [local]: self } : {}

		room.participants.setRecords(reconcile(participants))
		room.participants.setIds(local == null ? [] : [local])
	}

	const resetAsHost = (options: { secret?: RoomSecret | null } = {}) => {
		// Starting fresh as host makes a new room identity and color.
		room.relay.clear()
		room.session.stopBeacon()
		room.blips.clearPending()
		room.session.inviteSecret = options.secret ?? null
		room.session.keys = null
		room.session.selfId = randomParticipantId()
		room.session.hostId = room.session.selfId
		room.links.closeAll()

		const host = mergeParticipant(room.session.selfId)
		room.participants.setRecords(reconcile({ [host.id]: host }))
		room.participants.setIds([host.id])
		room.ui.setState('themeSeed', host.id)
	}

	const resetBeforeJoining = (options: { keepPendingBlip?: boolean } = {}) => {
		// Before welcome, a guest has no durable identity in this room.
		clearProjectedHostInvite()
		room.relay.clear()
		room.session.stopBeacon()
		if (!options.keepPendingBlip) room.blips.clearPending()
		room.session.inviteSecret = null
		room.session.keys = null
		room.session.selfId = null
		room.session.hostId = null
		room.links.closeAll()
		room.participants.setRecords(reconcile({}))
		room.participants.setIds([])
	}

	const markRoomClosed = (options: { keepRelayMetering?: boolean } = {}) => {
		// Closed is visible state plus real transport teardown.
		clearProjectedHostInvite()
		cancelSignaling()
		room.relay.clear({ keepMetering: options.keepRelayMetering ?? false })
		room.links.closeAll()
		clearPeerParticipants()
		room.ui.setState('entry', closedEntry())
	}

	const disposeRoom = () => {
		// Tear down browser resources in the opposite order people see them.
		cancelSignaling()
		room.relay.clear()
		room.links.closeAll()
		room.files.disposeFileUrls()
		room.media.disposeSelfMedia()
	}

	return { disposeRoom, markRoomClosed, resetAsHost, resetBeforeJoining }
}
