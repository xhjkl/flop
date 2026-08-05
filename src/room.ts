import { onCleanup, onMount } from 'solid-js'
import { hostInviteFromAddressBar } from './room/address-bar'
import { createBeaconFlow } from './room/entry/beacon'
import { createGuestFlow } from './room/entry/guest'
import { createHostFlow } from './room/entry/host'
import { readInviteFromHash } from './room/invite'
import { createRoomLinkEvents } from './room/link-events'
import { createRoomSession } from './room/session'

/** Browser-bound room controller disposed with its Solid owner. */
export const useRoom = () => {
	const room = createRoomSession()
	const beacon = createBeaconFlow(room)
	const host = createHostFlow(room, beacon)
	const guest = createGuestFlow(room, beacon, host)
	room.connections.bind(createRoomLinkEvents(room, host, guest))

	onMount(() => {
		// A same-tab reload retains host ownership; every other invite URL joins as a guest.
		const invite = readInviteFromHash()
		const hostInvite = hostInviteFromAddressBar()

		if (invite.type === 'invite-link') {
			if (hostInvite === invite.secret) {
				void host.startRoom(invite.secret)
				return
			}

			guest.joinRoomWithInviteLink(invite.secret)
			return
		}

		if (invite.type === 'manual-code') {
			void guest.joinInvite(invite.code)
			return
		}

		void host.startRoom()
	})

	onCleanup(room.dispose)

	const commands = {
		// Event handlers discard promises; command failures are reflected in room state.
		acceptReplyCode: (replyText: string) => {
			void host.acceptReplyCode(replyText)
		},
		becomeGuest: guest.becomeGuest,
		becomeHost: () => {
			void host.startRoom()
		},
		claimInviteLinkAsHost: guest.claimInviteLinkAsHost,
		joinInvite: (inviteText: string) => {
			void guest.joinInvite(inviteText)
		},
		dismissFileTransferIssue: room.dismissFileTransferIssue,
		enableSelfMedia: () => {
			void room.media.enable()
		},
		sendBlip: room.sendBlip,
		sendFiles: (files: File[]) => {
			void room.files.sendFiles(files)
		},
		setBlipDraft: room.setBlipDraft,
		setInviteText: (inviteText: string) => {
			if (room.state.entry.side !== 'guest') return
			room.setState('entry', {
				...room.state.entry,
				inviteText,
				issue: null,
			})
		},
		setReplyText: (replyText: string) => {
			if (room.state.entry.side !== 'host') return
			room.setState('entry', {
				...room.state.entry,
				issue: null,
				replyText,
			})
		},
		toggleCamera: room.media.toggleCamera,
		toggleMicrophone: room.media.toggleMicrophone,
		toggleScreen: room.media.toggleScreen,
		tryRelay: () => {
			void guest.tryRelay()
		},
	}

	return {
		commands,
		canClaimInviteAsHost: guest.canClaimInviteAsHost,
		peers: {
			all: room.peers.all,
		},
		self: room.self,
		state: room.state,
	}
}

export type RoomController = ReturnType<typeof useRoom>
