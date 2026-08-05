import { log } from '../../log'
import { decodeSignal, encodeSignal } from '../../manual-signal-codec'
import type { Packet, ParticipantId } from '../../protocol'
import { type RoomSecret, randomRoomSecret } from '../../rendezvous/secret'
import { projectHostInvite } from '../address-bar'
import { inviteCodeFromSignal, inviteLinkFromSecret } from '../invite'
import type { RoomConnection } from '../link'
import type { RendezvousAttempt, RoomSession } from '../session'
import type { BeaconFlow } from './beacon'
import { scheduleAdmissionTimeout } from './manual'
import { initialHostEntry } from './state'

export const createHostFlow = (room: RoomSession, beacon: BeaconFlow) => {
	const sendHostWelcome = (participantId: ParticipantId) => {
		const membership = room.membership()
		if (membership == null || membership.selfId !== membership.hostId) {
			log('error', 'room', 'welcome.missing-local-host-id', {
				participantId,
			})
			return false
		}

		if (
			!room.packets.sendToParticipant(participantId, {
				hostId: membership.hostId,
				roster: room.roster(),
				selfId: participantId,
				type: 'welcome',
			})
		) {
			log('warn', 'room', 'welcome.send.failed', { participantId })
			return false
		}

		const connection = room.peers.byId(participantId)?.connection ?? null
		if (connection != null) {
			room.packets.sendPortraitState(connection)
		}
		return true
	}

	const handleParticipantPacket = (
		participantId: ParticipantId,
		message: Packet,
	) => {
		if (room.packets.handleActivity(participantId, message)) return true
		switch (message.type) {
			case 'hello':
				if (!sendHostWelcome(participantId)) {
					room.peers.remove(participantId)
					return false
				}
				room.packets.broadcastRoster()
				break
			case 'peer-signal': {
				const selfId = room.membership()?.selfId ?? null
				if (message.to === selfId) {
					log('warn', 'room', 'mesh.signal.addressed-to-host', {
						from: participantId,
						type: message.type,
					})
					return true
				}
				if (
					!room.packets.sendToParticipant(message.to, {
						...message,
						from: participantId,
					})
				) {
					log('warn', 'room', 'mesh.signal.forward.failed', {
						from: participantId,
						to: message.to,
						type: message.type,
					})
				}
				break
			}
			case 'file-chunk':
			case 'file-end':
			case 'file-start':
			case 'roster':
			case 'blip':
			case 'media-state':
			case 'welcome':
				break
		}
		return true
	}

	const admitPeer = (connection: RoomConnection) => {
		// Membership must exist before assignment can make this connection visible.
		const participantId = room.peers.allocateId()
		room.peers.add(participantId)
		if (!room.connections.assign(connection, participantId)) {
			log('error', 'room', 'host.admit.assign-connection.failed', {
				connection,
				participantId,
			})
			room.peers.remove(participantId)
			return null
		}

		const entry = room.state.entry
		if (entry.side === 'host') {
			room.setState('entry', { ...entry, issue: null, replyText: '' })
		}
		log('info', 'room', 'host.admit', { connection, participantId })
		return participantId
	}

	const watchManualAdmission = (
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
			stillWaiting: () => true,
			onTimeout: () => {
				log('warn', 'room', 'manual.admission.timeout', {
					connection,
					nextStep: 'fresh-signaling-or-network-change',
				})
				room.connections.close(connection)
				const entry = room.state.entry
				if (entry.side === 'host') {
					room.setState('entry', {
						...entry,
						issue: 'host-reply-failed',
						manualPhase: 'waiting-for-reply',
					})
				}
				void refreshInvite().then(() => {
					const nextEntry = room.state.entry
					if (nextEntry.side !== 'host') return
					room.setState('entry', {
						...nextEntry,
						issue: 'host-reply-failed',
					})
				})
			},
		})
	}

	const prepareManualInvite = async (
		attempt: RendezvousAttempt,
		secret: RoomSecret,
	) => {
		let connection: RoomConnection | null = null
		try {
			const inviteLink = inviteLinkFromSecret(secret)
			projectHostInvite(secret, inviteLink)
			const currentEntry = room.state.entry
			room.setState('entry', {
				...initialHostEntry(),
				inviteLink,
				inviteLinkPhase:
					currentEntry.side === 'host'
						? currentEntry.inviteLinkPhase
						: 'preparing',
			})
			connection = room.connections.createAdmission({
				kind: 'manual',
				localRole: 'host',
			})
			const offer = await connection.rtc.createOffer()
			const inviteSignal = await encodeSignal(offer)
			if (
				!room.rendezvous.isCurrent(attempt) ||
				room.connections.manualAdmission('host') !== connection
			) {
				room.connections.close(connection)
				return
			}

			const entry = room.state.entry
			room.setState('entry', {
				...initialHostEntry(),
				inviteCode: inviteCodeFromSignal(inviteSignal),
				inviteLink,
				inviteLinkPhase:
					entry.side === 'host' ? entry.inviteLinkPhase : 'preparing',
				manualPhase: 'waiting-for-reply',
			})
		} catch (error) {
			log('warn', 'room', 'invite.create.failed', { error })
			if (connection != null) room.connections.close(connection)
			if (!room.rendezvous.isCurrent(attempt)) return
			const entry = room.state.entry
			room.setState('entry', {
				...(entry.side === 'host' ? entry : initialHostEntry()),
				issue: 'invite-creation-failed',
			})
		}
	}

	const startRoom = (secret: RoomSecret = randomRoomSecret()) => {
		room.resetForHosting()
		const attempt = room.rendezvous.start('host', secret)
		void beacon.start(attempt)
		return prepareManualInvite(attempt, secret)
	}

	const refreshInvite = () => {
		if (room.localRoomRole() !== 'host') return startRoom()

		const current = room.rendezvous.current
		if (current?.localRole !== 'host' || current.secret == null) {
			const secret = randomRoomSecret()
			const attempt = room.rendezvous.start('host', secret)
			void beacon.start(attempt)
			return prepareManualInvite(attempt, secret)
		}

		// The room and beacon stay live; only the copy-paste admission is replaced.
		room.connections.closeAdmissions(
			(connection) =>
				connection.origin.kind === 'manual' &&
				connection.origin.localRole === 'host',
		)
		return prepareManualInvite(current, current.secret)
	}

	const handleMessage = (connection: RoomConnection, message: Packet) => {
		const owner = room.connections.peerByConnection(connection)
		if (owner != null) {
			if (!handleParticipantPacket(owner.id, message)) {
				void refreshInvite()
			}
			return
		}
		if (message.type !== 'hello') {
			log('warn', 'room', 'host.rendezvous.message-before-hello', {
				connection,
				type: message.type,
			})
			return
		}

		const participantId = admitPeer(connection)
		if (participantId == null) return
		handleParticipantPacket(participantId, message)
		// Assignment keeps this connection while only the manual offer is replaced.
		void refreshInvite()
	}

	const acceptReplyCode = async (replyText: string) => {
		const replyCode = replyText.trim()
		const attempt = room.rendezvous.current
		const connection = room.connections.manualAdmission('host')
		if (
			replyCode === '' ||
			attempt == null ||
			attempt.localRole !== 'host' ||
			connection == null
		) {
			return
		}

		try {
			const entry = room.state.entry
			if (entry.side === 'host') {
				room.setState('entry', {
					...entry,
					issue: null,
					replyText: replyCode,
					manualPhase: 'accepting-reply',
				})
			}

			const answer = await decodeSignal(replyCode)
			if (answer.type !== 'answer') {
				throw new Error('Reply code did not contain an answer')
			}
			await connection.rtc.acceptAnswer(answer)
			if (
				!room.rendezvous.isCurrent(attempt) ||
				room.connections.manualAdmission('host') !== connection
			) {
				return
			}
			watchManualAdmission(connection, attempt)
		} catch (error) {
			log('warn', 'room', 'manual.reply.direct-connection.failed', {
				error,
				nextStep: 'fresh-reply-or-network-change',
			})
			if (!room.rendezvous.isCurrent(attempt)) return
			const entry = room.state.entry
			if (entry.side === 'host') {
				room.setState('entry', {
					...entry,
					issue: 'host-reply-failed',
					manualPhase: 'waiting-for-reply',
				})
			}
		}
	}

	return {
		acceptReplyCode,
		handleMessage,
		refreshInvite,
		startRoom,
	}
}

/** Host-side invite, admission, and room packet transitions. */
export type HostFlow = ReturnType<typeof createHostFlow>
