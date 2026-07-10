import { onCleanup, onMount } from 'solid-js'
import { hostInviteFromAddressBar } from './room/address-bar'
import { createBeaconFlow } from './room/beacon-flow'
import { createGuestFlow } from './room/guest'
import { createHostFlow } from './room/host'
import { copyText, readInviteFromHash } from './room/invite'
import { createRoomLifecycle } from './room/lifecycle'
import { createProtocolFlow } from './room/protocol-flow'
import { createRoomRuntime } from './room/runtime'
import type { RoomActions } from './room/types'
import type { GuestConnectionState, HostConnectionState } from './state'

export const createRoom = () => {
	const room = createRoomRuntime({
		linkEvents: {
			// Links are created only after this synchronous assembly binds protocol.
			onClose: (linkId) => protocol.handleLinkClose(linkId),
			onMessage: (linkId, text) => protocol.handleLinkMessage(linkId, text),
			onOpen: (linkId) => protocol.handleLinkOpen(linkId),
		},
	})
	const lifecycle = createRoomLifecycle(room)
	const beacon = createBeaconFlow(room)
	const host = createHostFlow(room, lifecycle, beacon)
	const guest = createGuestFlow(room, lifecycle, beacon, host)

	const protocol = createProtocolFlow(room, lifecycle, host, guest)

	onMount(() => {
		// Shared URLs make guests; a tab-owned projection lets host refresh stay host.
		const invite = readInviteFromHash()
		const hostInvite = hostInviteFromAddressBar()

		if (invite.type === 'invite-link') {
			if (hostInvite === invite.secret) {
				void host.startInviteAsHost({ secret: invite.secret })
				return
			}

			guest.joinRoomWithInviteLink(invite.secret)
			return
		}

		if (invite.type === 'manual-code') {
			void guest.createReply(invite.code)
			return
		}

		void host.startInviteAsHost()
	})

	onCleanup(lifecycle.disposeRoom)

	const hostText = (pick: (connection: HostConnectionState) => string) => {
		return room.state.connection.side === 'host'
			? pick(room.state.connection)
			: ''
	}

	const guestText = (pick: (connection: GuestConnectionState) => string) => {
		return room.state.connection.side === 'guest'
			? pick(room.state.connection)
			: ''
	}

	const actions: RoomActions = {
		// Keep UI callbacks synchronous-looking even when the room work is async.
		acceptReply: (replyText?: string) => void host.acceptReply(replyText),
		becomeGuest: guest.becomeGuest,
		becomeHost: () => void host.startInviteAsHost(),
		claimInviteLinkAsHost: guest.claimInviteLinkAsHost,
		copyInviteCode: () => void copyText(hostText((c) => c.inviteCode)),
		copyInviteLink: () => void copyText(hostText((c) => c.inviteLink)),
		copyReplyCode: () => void copyText(guestText((c) => c.replyCode)),
		createReply: (inviteText?: string) => void guest.createReply(inviteText),
		dismissBlipIssue: () => room.setState('blipComposer', 'issue', null),
		enableSelfMedia: () => void room.media.enableSelfMedia(),
		sendBlip: (text?: string) => room.blips.send(text),
		sendFiles: (files: File[]) => void room.fileTransfers.sendFiles(files),
		setBlipText: (text: string) => {
			room.setState('blipComposer', 'text', text)
			room.setState('blipComposer', 'issue', null)
		},
		setInviteText: (inviteText: string) => {
			if (room.state.connection.side !== 'guest') return
			room.setState('connection', {
				...room.state.connection,
				inviteText,
				issue: null,
			})
		},
		setReplyText: (replyText: string) => {
			if (room.state.connection.side !== 'host') return
			room.setState('connection', {
				...room.state.connection,
				issue: null,
				replyText,
			})
		},
		toggleCamera: room.media.toggleCamera,
		toggleMicrophone: room.media.toggleMicrophone,
		toggleScreen: room.media.toggleScreen,
		tryRelay: () => void guest.tryRelay(),
	}

	return {
		actions,
		canClaimFindingInviteLink: guest.canClaimFindingInviteLink,
		peers: room.peers,
		selfActivity: room.selfActivity,
		state: room.state,
	}
}

export type RoomHandle = ReturnType<typeof createRoom>
export type { RoomState } from './room/initial-state'
export type { RoomPeer } from './room/types'
