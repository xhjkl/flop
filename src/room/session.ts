import { createMemo, createSignal, createStore } from 'solid-js'
import type { SignalExchangeId } from '../../contracts/signal'
import { log } from '../log'
import {
	encodePacket,
	type MediaPresence,
	newParticipantId,
	type Packet,
	type ParticipantId,
	type RoomIdentity,
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

/** Keep protocol and media reads synchronous while Solid batches their render updates. */
const createRoomSnapshot = <T>(initial: T) => {
	let current = { value: initial }
	const [view, publish] = createSignal(current)
	return {
		get current() {
			return current.value
		},
		read: () => view().value,
		set: (value: T) => {
			if (value === current.value) return
			const snapshot = { value }
			publish(snapshot)
			current = snapshot
		},
	}
}

/** Stable participant view whose activity and transport can update independently. */
const createPeerRecord = (id: ParticipantId) => {
	const [blip, setBlip] = createSignal<string | null>(null)
	const connection = createRoomSnapshot<RoomConnection | null>(null)
	const files = createRoomSnapshot<SharedFile[]>([])
	const view: RoomPeer = {
		get blip() {
			return blip()
		},
		get connection() {
			return connection.read()?.view ?? null
		},
		get files() {
			return files.read()
		},
		id,
	}
	return { connection, files, id, setBlip, view }
}

/** Room state with one owner for identity, self activity, peers, and connections. */
export const createRoomSession = (
	createRtc: (options: RtcPeerOptions) => RtcPeer = createRtcPeer,
) => {
	const initialSelfId = newParticipantId()
	const admissions = new Set<RoomConnection>()
	let connectionEvents: ConnectionCallbacks | null = null
	let rendezvousAttempt: OwnedRendezvousAttempt | null = null
	let currentIdentity: RoomIdentity | null = {
		hostId: initialSelfId,
		selfId: initialSelfId,
	}
	const identity = () => currentIdentity
	const setIdentity = (value: RoomIdentity | null) => {
		currentIdentity = value
	}
	const peers = createRoomSnapshot<ReturnType<typeof createPeerRecord>[]>([])
	const peerViews: () => RoomPeer[] = createMemo(() =>
		peers.read().map((peer) => peer.view),
	)
	const selfMedia = createRoomSnapshot<SelfMedia>({ status: 'idle' })
	const [self, setSelf] = createStore<{
		blip: string | null
		blipDraft: string
		fileTransferIssue: FileTransferIssue | null
		files: SharedFile[]
	}>({
		blip: null,
		blipDraft: '',
		fileTransferIssue: null,
		files: [],
	})
	const selfView = {
		get blip() {
			return self.blip
		},
		get blipDraft() {
			return self.blipDraft
		},
		get fileTransferIssue() {
			return self.fileTransferIssue
		},
		get files() {
			return self.files
		},
		get media() {
			return selfMedia.read()
		},
	}
	const entry = createRoomSnapshot<RoomEntryState>(initialHostEntry())
	const [relayMetering, setRelayMetering] = createSignal<RelayMetering | null>(
		null,
	)
	const [themeSeed, setThemeSeed] = createSignal<string>(initialSelfId)
	const state = {
		get entry() {
			return entry.read()
		},
		get relayMetering() {
			return relayMetering()
		},
		/** Last known host retained through identity gaps for color continuity. */
		get themeSeed() {
			return themeSeed()
		},
	}

	const localRoomRole = (): LocalRoomRole | null => {
		const current = identity()
		if (current == null) return null
		return current.selfId === current.hostId ? 'host' : 'guest'
	}

	const peerById = (participantId: ParticipantId) => {
		return peers.current.find((peer) => peer.id === participantId) ?? null
	}

	const peerByConnection = (connection: RoomConnection) => {
		return (
			peers.current.find((peer) => peer.connection.current === connection) ??
			null
		)
	}

	const events = () => {
		if (connectionEvents == null) {
			throw new Error('Room connection events are not bound')
		}
		return connectionEvents
	}

	const peerConnections = () => {
		return peers.current.flatMap((peer) => peer.connection.current ?? [])
	}

	const allConnections = () => [...admissions, ...peerConnections()]
	const connectionFor = (id: ParticipantId) =>
		peerById(id)?.connection.current ?? null

	const relay = createRoomRelay({
		connections: allConnections,
		onStatsError: (error, connection) => {
			log('warn', 'room', 'relay.stats.failed', { error, connection })
		},
		setMetering: setRelayMetering,
	})

	const createConnection = (origin: ConnectionOrigin) => {
		let connection: RoomConnection
		const status = createRoomSnapshot<boolean>(false)
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
				setMediaStream(stream)
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
				return status.current
			},
			set connected(value) {
				status.set(value)
			},
			origin,
			rtc,
			setMediaPresence,
			setMediaStream,
			view: {
				get connected() {
					return status.read()
				},
				get mediaPresence() {
					return mediaPresence()
				},
				get mediaStream() {
					return mediaStream()
				},
			},
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
		connection.setMediaPresence(null)
		connection.setMediaStream(null)
		if (peer != null) {
			// Partial incoming bytes cannot cross a data-channel replacement.
			files.abortIncomingFrom(peer.id)
			peer.connection.set(null)
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
		const previous = peer.connection.current
		if (previous === connection) return true

		closeSiblingAdmissions(connection)
		if (previous != null) closeConnection(previous)
		admissions.delete(connection)
		peer.connection.set(connection)
		const media = selfMedia.current
		connection.rtc.setLocalMedia(
			media.status === 'live' ? media.publishedStream : null,
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
		const previous = peer.connection.current
		if (previous != null) closeConnection(previous)
		peer.connection.set(connection)
		const media = selfMedia.current
		connection.rtc.setLocalMedia(
			media.status === 'live' ? media.publishedStream : null,
		)
		return connection
	}

	const addPeer = (participantId: ParticipantId) => {
		if (peerById(participantId) != null) return
		const peer = createPeerRecord(participantId)
		peers.set([...peers.current, peer])
	}

	const roster = () => {
		const selfId = identity()?.selfId
		return selfId == null
			? []
			: [selfId, ...peers.current.map((peer) => peer.id)]
	}

	const allocateParticipantId = () => {
		while (true) {
			const id = newParticipantId()
			if (id === identity()?.selfId || id === identity()?.hostId) continue
			if (peerById(id) != null) continue
			return id
		}
	}

	const setPeerBlip = (participantId: ParticipantId, text: string) => {
		const blip = text.trim()
		const value = blip === '' ? null : blip
		const peer = peerById(participantId)
		peer?.setBlip(value)
	}

	/** Revoke the browser URL owned by a completed incoming file. */
	const releaseDownload = (file: SharedFile) => {
		if (file.state === 'download') URL.revokeObjectURL(file.url)
	}

	const upsertFile = (participantId: ParticipantId, nextFile: SharedFile) => {
		if (participantId === identity()?.selfId) {
			setSelf((draft) => {
				const file = draft.files.find((file) => file.id === nextFile.id)
				if (file == null) {
					draft.files.push(nextFile)
					return
				}
				Object.assign(file, nextFile)
			})
			return
		}
		const peer = peerById(participantId)
		if (peer == null) return

		const files = peer.files.current
		const index = files.findIndex((file) => file.id === nextFile.id)
		const previous = files[index] ?? null
		if (
			previous?.state === 'download' &&
			(nextFile.state !== 'download' || previous.url !== nextFile.url)
		) {
			releaseDownload(previous)
		}
		const next = files.slice()
		next[index === -1 ? next.length : index] = nextFile
		peer.files.set(next)
	}

	const connectedPeerConnections = () => {
		return peerConnections().filter((connection) => connection.connected)
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
		const connection = connectionFor(participantId)
		return connection == null ? false : sendPacket([connection], packet) === 1
	}

	const broadcastRoster = () => {
		sendPacket(connectedPeerConnections(), { type: 'roster', roster: roster() })
	}

	const setMediaPresence = (
		participantId: ParticipantId,
		presence: MediaPresence,
	) => {
		const connection = connectionFor(participantId)
		if (connection == null) return
		connection.setMediaPresence(presence)
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
		let text: string | null = null
		setSelf((draft) => {
			const blip = draft.blipDraft.trim()
			if (blip === '' && draft.blip == null) return

			draft.blip = blip === '' ? null : blip
			draft.blipDraft = blip
			text = blip
		})
		if (text == null) return
		sendPacket(connectedPeerConnections(), { type: 'blip', text })
	}

	const setFileTransferIssue = (issue: FileTransferIssue | null) => {
		setSelf((draft) => {
			draft.fileTransferIssue = issue
		})
	}

	const files = createRoomFileTransfers({
		connections: connectedPeerConnections,
		identity,
		sendPacket,
		setIssue: setFileTransferIssue,
		upsertFile,
	})

	const removePeer = (participantId: ParticipantId) => {
		const peer = peerById(participantId)
		if (peer == null) return

		for (const file of peer.files.current) releaseDownload(file)
		const connection = peer.connection.current
		if (connection != null) closeConnection(connection)
		peers.set(peers.current.filter((item) => item !== peer))
	}

	const replaceRoster = (nextRoster: Roster) => {
		const selfId = identity()?.selfId ?? null
		const remoteIds = nextRoster.filter((id) => id !== selfId)
		const retained = new Set(remoteIds)
		for (const peer of peers.current) {
			if (retained.has(peer.id)) continue

			for (const file of peer.files.current) releaseDownload(file)
			const connection = peer.connection.current
			if (connection != null) closeConnection(connection)
		}
		const next = remoteIds.map((id) => peerById(id) ?? createPeerRecord(id))
		peers.set(next)
	}

	const mesh = createRoomMesh({
		closeConnection,
		connectionFor,
		createConnection: connectPeer,
		identity,
		roster,
		sendToHost: (packet) => {
			const hostId = identity()?.hostId
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
		selfMedia: () => selfMedia.current,
		setSelfMedia: selfMedia.set,
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
		setIdentity({ hostId: selfId, selfId })
		replaceRoster([selfId])
		// Room churn must not replace the live capture or restart its preview.
		setSelf((draft) => {
			draft.blip = null
			draft.blipDraft = ''
			draft.fileTransferIssue = null
			draft.files = []
		})
		setThemeSeed(selfId)
	}

	const resetForJoining = (options: { preserveBlip?: boolean } = {}) => {
		clearProjectedHostInvite()
		mesh.reset()
		relay.clear()
		stopRendezvous()
		closeConnections()

		setIdentity(null)
		replaceRoster([])
		// Preserve live capture while this same person enters another room.
		setSelf((draft) => {
			if (!options.preserveBlip) draft.blip = null
			draft.blipDraft = draft.blip ?? ''
			draft.fileTransferIssue = null
			draft.files = []
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
		setIdentity(null)
		entry.set({ side: 'closed' })
	}

	const dispose = () => {
		// Reload consumes the address-bar marker to resume this tab's host room.
		mesh.reset()
		stopRendezvous()
		relay.clear()
		closeConnections()
		replaceRoster([])
		setIdentity(null)
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
		currentEntry: () => entry.current,
		dismissFileTransferIssue: () => setFileTransferIssue(null),
		connections: {
			all: allConnections,
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
			forPeer: connectionFor,
			isCurrent: connectionIsCurrent,
			openPeerConnections: connectedPeerConnections,
			peerByConnection,
			manualAdmission,
			remove: removeConnection,
		},
		files: {
			sendFiles: files.sendFiles,
		},
		identity,
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
			all: peerViews,
			allocateId: allocateParticipantId,
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
		self: selfView,
		setBlipDraft: (text: string) => {
			setSelf((draft) => {
				draft.blipDraft = text
			})
		},
		setEntry: entry.set,
		setIdentity,
		resetForHosting,
		resetForJoining,
		dispose,
		setThemeSeed,
		state,
	}
}

export type RoomSession = ReturnType<typeof createRoomSession>
