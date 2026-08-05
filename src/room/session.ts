import { createSignal } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { SignalExchangeId } from '../../contracts/signal'
import { log } from '../log'
import {
	encodePacket,
	type MediaPresence,
	newParticipantId,
	type Packet,
	type ParticipantId,
	type RoomMembership,
	type Roster,
} from '../protocol'
import type { createBeaconClient } from '../rendezvous/beacon'
import type { RoomKeys } from '../rendezvous/crypto'
import type { RoomSecret } from '../rendezvous/secret'
import { createRtcPeer, type RtcPeer, type RtcPeerOptions } from '../webrtc'
import { createRoomFileTransfers } from './activity/files'
import { clearProjectedHostInvite } from './address-bar'
import { createBeaconAuth } from './entry/auth'
import { initialHostEntry, type RoomEntryState } from './entry/state'
import {
	type ConnectionOrigin,
	hasRoomAccess,
	type LocalRoomRole,
	type RoomConnection,
} from './link'
import { createRoomMediaController, type SelfMedia } from './media'
import { createRoomMesh } from './mesh'
import type { FileTransferIssue, RoomPeer, SharedFile } from './participant'
import { createRoomRelay, type RelayMetering } from './relay'

/** Resources owned by the only rendezvous attempt allowed to update the room. */
export type RendezvousAttempt = {
	client: ReturnType<typeof createBeaconClient> | null
	keys: RoomKeys | null
	localRole: LocalRoomRole
	scheduleTimeout: (task: () => void, delayMs: number) => () => void
	secret: RoomSecret | null
	signal: AbortSignal
}

type OwnedRendezvousAttempt = RendezvousAttempt & { close: () => void }

/** Callbacks installed after the mutually dependent room flows are assembled. */
type ConnectionCallbacks = {
	onClose: (connection: RoomConnection) => void
	onMessage: (connection: RoomConnection, text: string) => void
	onOpen: (connection: RoomConnection) => void
}

/** Room state with one owner for membership, self activity, peers, and connections. */
export const createRoomSession = (
	createRtc: (options: RtcPeerOptions) => RtcPeer = createRtcPeer,
) => {
	const initialSelfId = newParticipantId()
	const admissions = new Set<RoomConnection>()
	let connectionEvents: ConnectionCallbacks | null = null
	let rendezvousAttempt: OwnedRendezvousAttempt | null = null
	const [membership, setMembership] = createSignal<RoomMembership | null>({
		hostId: initialSelfId,
		selfId: initialSelfId,
	})
	const [peers, setPeers] = createSignal<RoomPeer[]>([])
	const [self, setSelf] = createStore<{
		blip: string | null
		blipDraft: string
		fileTransferIssue: FileTransferIssue | null
		files: SharedFile[]
		media: SelfMedia
	}>({
		blip: null,
		blipDraft: '',
		fileTransferIssue: null,
		files: [],
		media: { status: 'idle' },
	})
	const [state, setState] = createStore<{
		entry: RoomEntryState
		relayMetering: RelayMetering | null
		/** Last known host identity retained through membership gaps for color continuity. */
		themeSeed: string
	}>({
		entry: initialHostEntry(),
		relayMetering: null,
		themeSeed: initialSelfId,
	})

	const localRoomRole = (): LocalRoomRole | null => {
		const current = membership()
		if (current == null) return null
		return current.selfId === current.hostId ? 'host' : 'guest'
	}

	/** Stable peer record whose reactive fields update without changing its reference. */
	const createPeerRecord = (id: ParticipantId): RoomPeer => {
		const [blip, setBlip] = createSignal<string | null>(null)
		const [connection, setConnection] = createSignal<RoomConnection | null>(
			null,
		)
		const [files, setFiles] = createSignal<SharedFile[]>([])
		return {
			get blip() {
				return blip()
			},
			set blip(value) {
				setBlip(value)
			},
			get connection() {
				return connection()
			},
			set connection(value) {
				setConnection(value)
			},
			get files() {
				return files()
			},
			set files(value) {
				setFiles(value)
			},
			id,
		}
	}

	const peerById = (participantId: ParticipantId) => {
		return peers().find((peer) => peer.id === participantId) ?? null
	}

	const peerByConnection = (connection: RoomConnection) => {
		return peers().find((peer) => peer.connection === connection) ?? null
	}

	const events = () => {
		if (connectionEvents == null) {
			throw new Error('Room connection events are not bound')
		}
		return connectionEvents
	}

	const peerConnections = () => {
		return peers().flatMap((peer) =>
			peer.connection == null ? [] : [peer.connection],
		)
	}

	const allConnections = () => [...admissions, ...peerConnections()]

	const relay = createRoomRelay({
		connections: allConnections,
		onStatsError: (error, connection) => {
			log('warn', 'room', 'relay.stats.failed', { error, connection })
		},
		setMetering: (metering) => setState('relayMetering', metering),
	})

	const createConnection = (origin: ConnectionOrigin) => {
		let connection: RoomConnection
		const [connected, setConnected] = createSignal(false)
		const [mediaPresence, setMediaPresence] =
			createSignal<MediaPresence | null>(null)
		// The stream object survives track churn, so same-reference writes still notify UI.
		const [mediaStream, setMediaStream] = createSignal<MediaStream | null>(
			null,
			{
				equals: false,
			},
		)
		const rtc = createRtc({
			...relay.peerOptions(),
			onOpen: () => events().onOpen(connection),
			onMessage: (text) => events().onMessage(connection, text),
			onRemoteMedia: (stream) => {
				if (!connectionIsCurrent(connection)) return
				connection.mediaStream = stream
			},
			onState: (snapshot) => {
				if (!connectionIsCurrent(connection)) return
				if (connection.origin.kind === 'mesh') return
				log('info', 'room', 'rtc.state', { connection, ...snapshot })
			},
			onClose: () => events().onClose(connection),
		})

		connection = {
			get connected() {
				return connected()
			},
			set connected(value) {
				setConnected(value)
			},
			get mediaPresence() {
				return mediaPresence()
			},
			set mediaPresence(value) {
				setMediaPresence(value)
			},
			get mediaStream() {
				return mediaStream()
			},
			set mediaStream(value) {
				setMediaStream(value)
			},
			origin,
			rtc,
		}
		// Anonymous rendezvous peers receive no camera or microphone before admission.
		rtc.setLocalMedia(null)
		return connection
	}

	const connectionIsCurrent = (connection: RoomConnection) => {
		return admissions.has(connection) || peerByConnection(connection) != null
	}

	const removeConnection = (connection: RoomConnection) => {
		const admitted = admissions.delete(connection)
		const peer = peerByConnection(connection)
		if (!admitted && peer == null) return

		connection.connected = false
		connection.mediaPresence = null
		connection.mediaStream = null
		if (peer != null) {
			// Partial incoming bytes cannot cross a data-channel replacement.
			files.abortIncomingFrom(peer.id)
			peer.connection = null
		}
	}

	const closeConnection = (connection: RoomConnection) => {
		if (!connectionIsCurrent(connection)) return
		removeConnection(connection)
		try {
			connection.rtc.close()
		} catch {}
	}

	const closeConnections = () => {
		for (const connection of allConnections()) closeConnection(connection)
	}

	const manualAdmission = (localRole: LocalRoomRole) => {
		for (const connection of admissions) {
			if (connection.origin.kind !== 'manual') continue
			if (connection.origin.localRole === localRole) return connection
		}
		return null
	}

	const createAdmission = (
		origin: Exclude<ConnectionOrigin, { kind: 'mesh' }>,
	) => {
		const connection = createConnection(origin)
		admissions.add(connection)
		return connection
	}

	const closeAdmissions = (
		matches: (connection: RoomConnection) => boolean,
	) => {
		for (const connection of [...admissions]) {
			if (matches(connection)) closeConnection(connection)
		}
	}

	const closeSiblingAdmissions = (connection: RoomConnection) => {
		if (connection.origin.kind === 'mesh') return
		for (const candidate of [...admissions]) {
			if (candidate === connection) continue
			if (candidate.origin.kind !== connection.origin.kind) continue
			if (candidate.origin.localRole !== connection.origin.localRole) continue
			if (
				candidate.origin.kind === 'beacon' &&
				connection.origin.kind === 'beacon' &&
				candidate.origin.peerId !== connection.origin.peerId
			) {
				continue
			}
			closeConnection(candidate)
		}
	}

	const assignConnection = (
		connection: RoomConnection,
		participantId: ParticipantId,
	) => {
		if (!connectionIsCurrent(connection)) return false
		if (!hasRoomAccess(connection)) {
			log('warn', 'room', 'connection.assign.before-auth', {
				connection,
				participantId,
			})
			closeConnection(connection)
			return false
		}

		const peer = peerById(participantId)
		if (peer == null) return false
		if (peer.connection === connection) return true

		closeSiblingAdmissions(connection)
		if (peer.connection != null) closeConnection(peer.connection)
		admissions.delete(connection)
		peer.connection = connection
		connection.rtc.setLocalMedia(
			self.media.status === 'live' ? self.media.publishedStream : null,
		)
		return true
	}

	const connectPeer = (
		participantId: ParticipantId,
		exchangeId: SignalExchangeId,
	) => {
		const peer = peerById(participantId)
		if (peer == null) {
			log('warn', 'room', 'mesh.connection.unknown-participant', {
				participantId,
			})
			return null
		}

		const connection = createConnection({ exchangeId, kind: 'mesh' })
		if (peer.connection != null) closeConnection(peer.connection)
		peer.connection = connection
		connection.rtc.setLocalMedia(
			self.media.status === 'live' ? self.media.publishedStream : null,
		)
		return connection
	}

	const addPeer = (participantId: ParticipantId) => {
		if (peerById(participantId) != null) return
		setPeers((current) => [...current, createPeerRecord(participantId)])
	}

	const roster = () => {
		const selfId = membership()?.selfId
		return selfId == null ? [] : [selfId, ...peers().map((peer) => peer.id)]
	}

	const allocateParticipantId = () => {
		while (true) {
			const id = newParticipantId()
			if (id === membership()?.selfId || id === membership()?.hostId) continue
			if (peerById(id) != null) continue
			return id
		}
	}

	const setPeerBlip = (participantId: ParticipantId, text: string) => {
		const blip = text.trim()
		const value = blip === '' ? null : blip
		const peer = peerById(participantId)
		if (peer != null) peer.blip = value
	}

	/** Revoke the browser URL owned by a completed incoming file. */
	const releaseDownload = (file: SharedFile) => {
		if (file.state === 'download') URL.revokeObjectURL(file.url)
	}

	const upsertFile = (participantId: ParticipantId, nextFile: SharedFile) => {
		const upsert = (files: SharedFile[]) => {
			const index = files.findIndex((file) => file.id === nextFile.id)
			const previous = files[index] ?? null
			if (
				previous?.state === 'download' &&
				(nextFile.state !== 'download' || previous.url !== nextFile.url)
			) {
				releaseDownload(previous)
			}
			return index === -1
				? [...files, nextFile]
				: files.map((file, itemIndex) =>
						itemIndex === index ? nextFile : file,
					)
		}
		if (participantId === membership()?.selfId) {
			setSelf('files', upsert)
			return
		}
		const peer = peerById(participantId)
		if (peer != null) peer.files = upsert(peer.files)
	}

	const connectedPeerConnections = () => {
		return peers().flatMap((peer) =>
			peer.connection?.connected ? [peer.connection] : [],
		)
	}

	const sendPacket = (targets: RoomConnection[], packet: Packet) => {
		const text = encodePacket(packet)
		let sent = 0
		for (const connection of targets) {
			if (connection.connected && connection.rtc.trySend(text)) sent++
		}
		return sent
	}

	const sendToParticipant = (participantId: ParticipantId, packet: Packet) => {
		const connection = peerById(participantId)?.connection ?? null
		return connection == null ? false : sendPacket([connection], packet) === 1
	}

	const broadcastRoster = () => {
		sendPacket(connectedPeerConnections(), { type: 'roster', roster: roster() })
	}

	const setMediaPresence = (
		participantId: ParticipantId,
		presence: MediaPresence,
	) => {
		const connection = peerById(participantId)?.connection ?? null
		if (connection == null) return
		connection.mediaPresence = presence
	}

	const startRendezvous = (
		localRole: LocalRoomRole,
		secret: RoomSecret | null,
	): RendezvousAttempt => {
		stopRendezvous()
		const abort = new AbortController()
		const timers = new Set<ReturnType<typeof setTimeout>>()
		const attempt: OwnedRendezvousAttempt = {
			client: null,
			close: () => {
				abort.abort()
				attempt.client?.close()
				attempt.client = null
				attempt.keys = null
				for (const timer of timers) clearTimeout(timer)
				timers.clear()
			},
			keys: null,
			localRole,
			scheduleTimeout: (task, delayMs) => {
				const timer = setTimeout(() => {
					timers.delete(timer)
					task()
				}, delayMs)
				timers.add(timer)
				return () => {
					clearTimeout(timer)
					timers.delete(timer)
				}
			},
			secret,
			signal: abort.signal,
		}
		rendezvousAttempt = attempt
		return attempt
	}

	const stopRendezvous = () => {
		const attempt = rendezvousAttempt
		if (attempt == null) return
		rendezvousAttempt = null
		attempt.close()
		closeAdmissions(() => true)
	}

	const rendezvous = {
		get current(): RendezvousAttempt | null {
			return rendezvousAttempt
		},
		isCurrent: (attempt: RendezvousAttempt) => rendezvousAttempt === attempt,
		start: startRendezvous,
		stop: stopRendezvous,
	}

	const auth = createBeaconAuth({
		closeConnection,
		connectionIsCurrent,
		roomKeys: () => rendezvousAttempt?.keys ?? null,
		verifyConnection: (connection) => {
			if (connection.origin.kind !== 'beacon') return
			connection.origin.authenticated = true
		},
	})

	const sendBlip = () => {
		const blip = self.blipDraft.trim()
		if (blip === '' && self.blip == null) return

		// Commit before publishing so later connections replay the same value.
		setSelf('blip', blip === '' ? null : blip)
		sendPacket(connectedPeerConnections(), { type: 'blip', text: blip })
		setSelf('blipDraft', blip)
	}

	const files = createRoomFileTransfers({
		connections: connectedPeerConnections,
		localParticipantId: () => membership()?.selfId ?? null,
		sendPacket,
		setIssue: (issue) => setSelf('fileTransferIssue', issue),
		upsertFile,
	})

	const removePeer = (participantId: ParticipantId) => {
		const peer = peerById(participantId)
		if (peer == null) return

		for (const file of peer.files) releaseDownload(file)
		if (peer.connection != null) closeConnection(peer.connection)
		setPeers((current) => current.filter((item) => item.id !== participantId))
	}

	const replaceRoster = (nextRoster: Roster) => {
		const selfId = membership()?.selfId ?? null
		const remoteIds = nextRoster.filter((id) => id !== selfId)
		const retained = new Set(remoteIds)
		for (const peer of peers()) {
			if (retained.has(peer.id)) continue

			for (const file of peer.files) releaseDownload(file)
			if (peer.connection != null) closeConnection(peer.connection)
		}
		setPeers((current) =>
			remoteIds.map(
				(id) => current.find((peer) => peer.id === id) ?? createPeerRecord(id),
			),
		)
	}

	const mesh = createRoomMesh({
		closeConnection,
		connectionFor: (id) => peerById(id)?.connection ?? null,
		createConnection: connectPeer,
		membership,
		roster,
		sendToHost: (packet) => {
			const hostId = membership()?.hostId
			return hostId == null ? false : sendToParticipant(hostId, packet)
		},
	})

	const media = createRoomMediaController({
		connections: peerConnections,
		publishPresence: (presence) => {
			sendPacket(connectedPeerConnections(), {
				...presence,
				type: 'media-state',
			})
		},
		selfMedia: () => self.media,
		setSelfMedia: (selfMedia) => setSelf('media', selfMedia),
	})

	const sendPortraitState = (connection: RoomConnection) => {
		sendPacket([connection], { type: 'blip', text: self.blip ?? '' })
		sendPacket([connection], {
			...media.presence(),
			type: 'media-state',
		})
	}

	const resetForHosting = () => {
		mesh.reset()
		relay.clear()
		stopRendezvous()
		closeConnections()

		const selfId = newParticipantId()
		setMembership({ hostId: selfId, selfId })
		replaceRoster([selfId])
		// Room churn must not replace the live capture or restart its preview.
		setSelf({
			blip: null,
			blipDraft: '',
			fileTransferIssue: null,
			files: [],
		})
		setState('themeSeed', selfId)
	}

	const resetForJoining = (options: { preserveBlip?: boolean } = {}) => {
		const blip = options.preserveBlip ? self.blip : null
		const blipDraft = blip ?? ''
		clearProjectedHostInvite()
		mesh.reset()
		relay.clear()
		stopRendezvous()
		closeConnections()

		setMembership(null)
		replaceRoster([])
		// Preserve live capture while this same person enters another room.
		setSelf({
			blip,
			blipDraft,
			fileTransferIssue: null,
			files: [],
		})
	}

	const closeRoom = (options: { preserveRelayMetering?: boolean } = {}) => {
		clearProjectedHostInvite()
		mesh.reset()
		stopRendezvous()
		relay.clear({
			keepMetering: options.preserveRelayMetering ?? false,
		})
		closeConnections()
		replaceRoster([])
		setMembership(null)
		setState('entry', { side: 'closed' })
	}

	const dispose = () => {
		// Reload consumes the address-bar marker to resume this tab's host room.
		mesh.reset()
		stopRendezvous()
		relay.clear()
		closeConnections()
		replaceRoster([])
		setMembership(null)
		media.dispose()
	}

	const handleActivityPacket = (
		participantId: ParticipantId,
		message: Packet,
	) => {
		switch (message.type) {
			case 'blip':
				setPeerBlip(participantId, message.text)
				return true
			case 'media-state':
				setMediaPresence(participantId, message)
				return true
			case 'file-start':
				files.handleFileStart(participantId, message)
				return true
			case 'file-chunk':
				files.handleFileChunk(participantId, message)
				return true
			case 'file-end':
				files.handleFileEnd(participantId, message)
				return true
			default:
				return false
		}
	}

	return {
		auth,
		closeRoom,
		dismissFileTransferIssue: () => setSelf('fileTransferIssue', null),
		connections: {
			admissions: () => [...admissions],
			assign: assignConnection,
			bind: (handlers: ConnectionCallbacks) => {
				if (connectionEvents != null) {
					throw new Error('Room connection events already bound')
				}
				connectionEvents = handlers
			},
			close: closeConnection,
			closeAdmissions,
			createAdmission,
			isCurrent: connectionIsCurrent,
			openPeerConnections: connectedPeerConnections,
			peerByConnection,
			manualAdmission,
			remove: removeConnection,
		},
		files: {
			sendFiles: files.sendFiles,
		},
		membership,
		media: {
			enable: media.enable,
			toggleCamera: media.toggleCamera,
			toggleMicrophone: media.toggleMicrophone,
			toggleScreen: media.toggleScreen,
		},
		mesh,
		packets: {
			broadcastRoster,
			handleActivity: handleActivityPacket,
			sendPortraitState,
			sendToParticipant,
		},
		peers: {
			add: addPeer,
			all: peers,
			allocateId: allocateParticipantId,
			byId: peerById,
			remove: removePeer,
			replaceRoster,
		},
		relay: {
			active: relay.active,
			start: relay.start,
		},
		rendezvous,
		roster,
		localRoomRole,
		sendBlip,
		self,
		setBlipDraft: (text: string) => setSelf('blipDraft', text),
		setMembership,
		resetForHosting,
		resetForJoining,
		dispose,
		setState,
		state,
	}
}

export type RoomSession = ReturnType<typeof createRoomSession>
