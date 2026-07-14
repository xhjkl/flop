import { onCleanup, onMount } from 'solid-js'
import { hostInviteFromAddressBar } from './room/address-bar'
import { createBeaconFlow } from './room/entry/beacon'
import { createGuestFlow } from './room/entry/guest'
import { createHostFlow } from './room/entry/host'
import type { GuestJoinState, HostInviteState } from './room/entry/state'
import { copyText, readInviteFromHash } from './room/invite'
import { createRoomLifecycle } from './room/lifecycle'
import { createRoomLinkEvents } from './room/link-events'
import { createRoomSession } from './room/session'

/** UI verbs; host/guest ceremony stays inside the room implementation. */
export type RoomActions = {
	acceptReply: (replyText?: string) => void
	becomeGuest: () => void
	becomeHost: () => void
	claimInviteLinkAsHost: () => void
	copyInviteLink: () => void
	copyInviteCode: () => void
	copyReplyCode: () => void
	createReply: (inviteText?: string) => void
	dismissBlipIssue: () => void
	enableSelfMedia: () => void
	sendBlip: (text?: string) => void
	sendFiles: (files: File[]) => void
	setBlipText: (text: string) => void
	setInviteText: (inviteText: string) => void
	setReplyText: (replyText: string) => void
	toggleCamera: () => void
	toggleMicrophone: () => void
	toggleScreen: () => void
	tryRelay: () => void
}

export const createRoom = () => {
	const room = createRoomSession()
	const lifecycle = createRoomLifecycle(room)
	const beacon = createBeaconFlow(room)
	const host = createHostFlow(room, lifecycle, beacon)
	const guest = createGuestFlow(room, lifecycle, beacon, host)
	room.links.bind(createRoomLinkEvents(room, lifecycle, host, guest))

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

	const hostText = (pick: (entry: HostInviteState) => string) => {
		return room.ui.state.entry.side === 'host' ? pick(room.ui.state.entry) : ''
	}

	const guestText = (pick: (entry: GuestJoinState) => string) => {
		return room.ui.state.entry.side === 'guest' ? pick(room.ui.state.entry) : ''
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
		dismissBlipIssue: () => room.ui.setState('blipComposer', 'issue', null),
		enableSelfMedia: () => void room.media.enableSelfMedia(),
		sendBlip: (text?: string) => room.blips.send(text),
		sendFiles: (files: File[]) => void room.files.sendFiles(files),
		setBlipText: (text: string) => {
			room.ui.setState('blipComposer', 'text', text)
			room.ui.setState('blipComposer', 'issue', null)
		},
		setInviteText: (inviteText: string) => {
			if (room.ui.state.entry.side !== 'guest') return
			room.ui.setState('entry', {
				...room.ui.state.entry,
				inviteText,
				issue: null,
			})
		},
		setReplyText: (replyText: string) => {
			if (room.ui.state.entry.side !== 'host') return
			room.ui.setState('entry', {
				...room.ui.state.entry,
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
		peers: room.participants.views,
		selfActivity: room.participants.selfActivity,
		state: room.ui.state,
	}
}

export type RoomHandle = ReturnType<typeof createRoom>
export type { RoomState } from './room/initial-state'
export type { ParticipantView } from './room/participant'
