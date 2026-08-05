import { batch } from 'solid-js'
import { log } from '../../log'
import { decodeSignal, encodeSignal } from '../../manual-signal-codec'
import type { Packet, Roster } from '../../protocol'
import type { RoomSecret } from '../../rendezvous/secret'
import { inviteFromInput, inviteLinkFromSecret } from '../invite'
import type { RoomConnection } from '../link'
import { RelayQuotaExceededError, requestRelayIceServers } from '../relay'
import type { RendezvousAttempt, RoomSession } from '../session'
import type { BeaconFlow } from './beacon'
import type { HostFlow } from './host'
import { scheduleAdmissionTimeout } from './manual'
import { asHostDiscovery, initialGuestEntry } from './state'

export const createGuestFlow = (
	room: RoomSession,
	beacon: BeaconFlow,
	host: HostFlow,
) => {
	const applyRoster = (roster: Roster) => {
		const identity = room.identity()
		if (identity == null) return
		if (
			!roster.includes(identity.hostId) ||
			!roster.includes(identity.selfId)
		) {
			log('warn', 'room', 'roster.missing-required-participant', {
				hostId: identity.hostId,
				selfId: identity.selfId,
			})
			room.closeRoom()
			return
		}

		room.peers.replaceRoster(roster)
		room.mesh.connectMissingPeers()
	}

	let relayRequest: {
		attempt: RendezvousAttempt
		promise: Promise<void>
	} | null = null

	const hostDiscoveryAttempt = () => {
		const attempt = room.rendezvous.current
		return asHostDiscovery(room.state.entry) != null &&
			attempt?.localRole === 'guest' &&
			attempt.secret != null
			? attempt
			: null
	}

	const stillDiscoveringHost = (attempt: RendezvousAttempt) => {
		return (
			room.rendezvous.isCurrent(attempt) &&
			asHostDiscovery(room.state.entry) != null
		)
	}

	const acceptWelcome = (
		connection: RoomConnection,
		message: Extract<Packet, { type: 'welcome' }>,
	) => {
		let assigned = false
		batch(() => {
			// Assignment observes the new identity and its host peer from this roster.
			room.setIdentity({ hostId: message.hostId, selfId: message.selfId })
			room.peers.replaceRoster(message.roster)
			assigned = room.connections.assign(connection, message.hostId)
		})
		if (!assigned) {
			log('error', 'room', 'guest.welcome.assign-host-connection.failed', {
				connection,
				hostId: message.hostId,
			})
			room.closeRoom()
			return
		}

		// Assignment moves the host out of attempt-owned admissions before they close.
		room.rendezvous.stop()
		room.setState('themeSeed', message.hostId)
		const entry = room.state.entry
		room.setState('entry', {
			side: 'guest',
			inviteText: entry.side === 'guest' ? entry.inviteText : '',
			issue: null,
			status: 'connected',
		})
		room.packets.sendPortraitState(connection)
		room.mesh.connectMissingPeers()
	}

	const handleMessage = (connection: RoomConnection, message: Packet) => {
		const senderId =
			room.connections.peerByConnection(connection)?.id ??
			room.identity()?.hostId ??
			null
		if (senderId != null && room.packets.handleActivity(senderId, message))
			return

		switch (message.type) {
			case 'welcome':
				acceptWelcome(connection, message)
				break
			case 'roster':
				applyRoster(message.roster)
				break
			case 'peer-signal':
				void room.mesh.handleSignal(message)
				break
			case 'file-chunk':
			case 'file-end':
			case 'file-start':
			case 'hello':
			case 'blip':
			case 'media-state':
				break
		}
	}

	const joinRoomWithInviteLink = (secret: RoomSecret) => {
		room.resetForJoining({ preserveBlip: true })
		const attempt = room.rendezvous.start('guest', secret)
		room.setState('entry', {
			...initialGuestEntry(),
			hostPresent: null,
			inviteText: inviteLinkFromSecret(secret),
			relayFallbackSecondsLeft: null,
			status: 'discovering-host',
		})
		void beacon.start(attempt)
	}

	const tryRelay = () => {
		const startingAttempt = hostDiscoveryAttempt()
		if (startingAttempt == null || startingAttempt.secret == null) {
			return Promise.resolve()
		}
		if (relayRequest?.attempt === startingAttempt) return relayRequest.promise

		const promise = (async () => {
			try {
				const iceServers = await requestRelayIceServers(startingAttempt.signal)
				if (!stillDiscoveringHost(startingAttempt)) return

				const attempt = room.rendezvous.start('guest', startingAttempt.secret)
				room.relay.start(iceServers, () =>
					room.closeRoom({ preserveRelayMetering: true }),
				)
				const entry = asHostDiscovery(room.state.entry)
				if (entry == null) return
				room.setState('entry', {
					...entry,
					issue: null,
					relayFallbackSecondsLeft: null,
				})
				void beacon.start(attempt)
			} catch (error) {
				if (!stillDiscoveringHost(startingAttempt)) return
				log('warn', 'room', 'relay.start.failed', { error })

				const entry = asHostDiscovery(room.state.entry)
				if (entry == null) return
				room.setState('entry', {
					...entry,
					issue:
						error instanceof RelayQuotaExceededError
							? 'relay-quota-exceeded'
							: 'relay-unavailable',
					relayFallbackSecondsLeft: null,
				})
			}
		})()
		relayRequest = { attempt: startingAttempt, promise }
		void promise.finally(() => {
			if (relayRequest?.attempt === startingAttempt) relayRequest = null
		})
		return promise
	}

	const canClaimInviteAsHost = () => {
		const entry = asHostDiscovery(room.state.entry)
		return (
			hostDiscoveryAttempt() != null &&
			entry != null &&
			entry.issue == null &&
			entry.hostPresent === false
		)
	}

	const claimInviteLinkAsHost = () => {
		if (!canClaimInviteAsHost()) return
		const secret = hostDiscoveryAttempt()?.secret ?? null
		if (secret == null) return

		void host.startRoom(secret)
	}

	const becomeGuest = () => {
		room.resetForJoining()
		room.setState('entry', initialGuestEntry())
	}

	const watchReplyAdmission = (
		connection: RoomConnection,
		attempt: RendezvousAttempt,
	) => {
		scheduleAdmissionTimeout({
			attempt,
			connection,
			isCurrent: room.rendezvous.isCurrent,
			isUnassigned: (candidate) =>
				room.connections.isCurrent(candidate) &&
				room.connections.peerByConnection(candidate) == null,
			stillWaiting: () =>
				room.state.entry.side === 'guest' &&
				room.state.entry.status === 'reply-ready',
			onTimeout: () => {
				log('warn', 'room', 'manual.admission.waiting', {
					connection,
					nextStep: 'resend-reply-or-fresh-invite',
				})
				const entry = room.state.entry
				if (entry.side !== 'guest') return
				room.setState('entry', {
					...entry,
					issue: 'reply-still-waiting',
				})
			},
		})
	}

	const joinInvite = async (inviteText: string) => {
		const inviteInput = inviteText.trim()
		const invite = inviteFromInput(inviteInput)
		if (invite.type === 'empty') return
		if (invite.type === 'invite-link') {
			joinRoomWithInviteLink(invite.secret)
			return
		}

		room.resetForJoining({ preserveBlip: true })
		const attempt = room.rendezvous.start('guest', null)
		room.setState('entry', {
			...initialGuestEntry(),
			inviteText: inviteInput,
			status: 'creating-reply',
		})

		let connection: RoomConnection | null = null
		try {
			connection = room.connections.createAdmission({
				kind: 'manual',
				localRole: 'guest',
			})
			const offer = await decodeSignal(invite.code)
			if (offer.type !== 'offer') {
				throw new Error('Invite code did not contain an offer')
			}
			const answer = await connection.rtc.createAnswer(offer)
			const replyCode = await encodeSignal(answer)
			if (
				!room.rendezvous.isCurrent(attempt) ||
				room.connections.manualAdmission('guest') !== connection
			) {
				room.connections.close(connection)
				return
			}

			room.setState('entry', {
				...initialGuestEntry(),
				inviteText: inviteInput,
				replyCode,
				status: 'reply-ready',
			})
			watchReplyAdmission(connection, attempt)
		} catch (error) {
			log('warn', 'room', 'reply.create.failed', { error })
			if (connection != null) room.connections.close(connection)
			if (!room.rendezvous.isCurrent(attempt)) return
			room.rendezvous.stop()
			room.setState('entry', {
				...initialGuestEntry(),
				inviteText: inviteInput,
				issue: 'invite-invalid',
			})
		}
	}

	return {
		becomeGuest,
		canClaimInviteAsHost,
		claimInviteLinkAsHost,
		joinInvite,
		handleMessage,
		joinRoomWithInviteLink,
		tryRelay,
	}
}

/** Guest-side invite consumption, welcome, and roster transitions. */
export type GuestFlow = ReturnType<typeof createGuestFlow>
