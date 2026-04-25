import { onCleanup, onMount } from 'solid-js'
import { createStore } from 'solid-js/store'
import { base64ToBytes, bytesToBase64 } from './binary'
import {
	decodeRoomMessage,
	encodeRoomMessage,
	type Participant,
	type ParticipantId,
	participantIdToString,
	type RoomMessage,
} from './room-protocol'
import type {
	BlipComposerState,
	ConnectionState,
	PeerState,
	PortraitActivityState,
	PortraitFileState,
} from './room-types'
import {
	captureSelfMedia,
	emptySelfMedia,
	type SelfMedia,
	setSelfMediaTracksEnabled,
	stopSelfMedia,
} from './self-media'
import { createPeer, type Peer } from './webrtc'

export type RoomPeer = {
	activity: PortraitActivityState
	colorSeed: string
	mediaStream: MediaStream | null
	state: PeerState
}

export type RoomState = {
	blipComposer: BlipComposerState
	connection: ConnectionState
	peers: RoomPeer[]
	selfMedia: SelfMedia
	selfActivity: PortraitActivityState
	themeSeed: string
}

type PeerLink = {
	live: boolean
	peer: Peer
}

type IncomingFileTransfer = {
	chunks: ArrayBuffer[]
	from: ParticipantId
	mime: string
	name: string
	receivedBytes: number
	size: number
}

type FileProgress = {
	id: string
	name: string
	receivedBytes: number
	size: number
	state: PortraitFileState['state']
	url: string | null
}

type PersonActivity = {
	blip: string | null
	files: FileProgress[]
}

// The UI cares about people. A WebRTC link is just one possible thing a person has.
type RoomPerson = Participant & {
	activity: PersonActivity
	link: PeerLink | null
	mediaStream: MediaStream | null
}

const FILE_CHUNK_BYTES = 16 * 1024
const FILE_BUFFER_LOW_BYTES = 512 * 1024

const emptyHostConnection = (): ConnectionState => ({
	phase: 'creating-invite',
	inviteLink: '',
	inviteText: '',
	replyCode: '',
	replyText: '',
	issue: null,
})

const emptyGuestConnection = (): ConnectionState => ({
	phase: 'needs-invite',
	inviteLink: '',
	inviteText: '',
	replyCode: '',
	replyText: '',
	issue: null,
})

const emptyBlipComposer = (): BlipComposerState => ({
	issue: null,
	text: '',
})

function emptyPersonActivity(): PersonActivity {
	return { blip: null, files: [] }
}

function createPerson(participant: Participant): RoomPerson {
	return {
		...participant,
		activity: emptyPersonActivity(),
		link: null,
		mediaStream: null,
	}
}

function publicParticipant(person: RoomPerson): Participant {
	return { id: person.id, name: person.name, role: person.role }
}

function copyText(text: string) {
	return navigator.clipboard?.writeText(text).catch(() => null) ?? null
}

function safeDecodeURIComponent(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function inviteCodeFromHash(hashText: string) {
	const hash = hashText.replace(/^#/, '')
	if (hash.trim() === '') return null

	return safeDecodeURIComponent(hash)
}

function inviteCodeFromInput(text: string) {
	const input = text.trim()
	if (input === '') return ''

	// People paste full links, hashes, and raw codes. Make all of them feel like the same gesture.
	try {
		const url = new URL(input)
		const inviteCode = inviteCodeFromHash(url.hash)
		if (inviteCode != null) return inviteCode
	} catch {}

	if (input.startsWith('#')) {
		const inviteCode = inviteCodeFromHash(input)
		if (inviteCode != null) return inviteCode
	}

	return input
}

function readInviteFromHash() {
	return inviteCodeFromHash(window.location.hash)
}

function clearInviteHash() {
	if (window.location.hash === '') return

	const url = new URL(window.location.href)
	url.hash = ''
	window.history.replaceState(null, '', url)
}

function inviteLinkFromCode(inviteCode: string) {
	const url = new URL(window.location.href)
	url.hash = inviteCode
	return url.href
}

function randomParticipantId(): ParticipantId {
	const bytes = new Uint8Array(8)
	crypto.getRandomValues(bytes)
	let id = 0n

	for (const byte of bytes) {
		id = (id << 8n) | BigInt(byte)
	}

	return id
}

function sendRoomMessage(peer: Peer, message: RoomMessage) {
	return peer.send(encodeRoomMessage(message))
}

function roomDebug(event: string, details: Record<string, unknown> = {}) {
	console.debug('[flop:room]', JSON.stringify({ event, ...details }))
}

function mediaTracks(stream: MediaStream | null) {
	return (
		stream?.getTracks().map((track) => ({
			enabled: track.enabled,
			id: track.id,
			kind: track.kind,
			muted: track.muted,
			readyState: track.readyState,
		})) ?? []
	)
}

function randomTransferId() {
	const bytes = new Uint8Array(12)
	crypto.getRandomValues(bytes)
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createRoom() {
	let pendingPeer: Peer | null = null
	let pendingPeerVersion = 0
	let participantSequence = 0
	const incomingFiles = new Map<string, IncomingFileTransfer>()
	let fileUrls = new Set<string>()
	let pendingLocalBlip: string | null = null
	// Host identity is the closest thing we have to room identity, so it also paints the room.
	let localParticipantId: ParticipantId | null = randomParticipantId()
	let hostParticipantId: ParticipantId | null = localParticipantId
	let people = new Map<ParticipantId, RoomPerson>([
		[
			localParticipantId,
			createPerson({ id: localParticipantId, name: 'Room host', role: 'host' }),
		],
	])
	let connectionVersion = 0
	let selfMediaVersion = 0

	const [state, setState] = createStore<RoomState>({
		blipComposer: emptyBlipComposer(),
		connection: emptyHostConnection(),
		peers: [],
		selfMedia: emptySelfMedia(),
		selfActivity: { blip: null, files: [] },
		themeSeed: participantIdToString(localParticipantId),
	})

	function isHostRoom() {
		return (
			localParticipantId != null && localParticipantId === hostParticipantId
		)
	}

	function isGuestRoom() {
		return (
			localParticipantId != null &&
			hostParticipantId != null &&
			localParticipantId !== hostParticipantId
		)
	}

	function closePendingPeer() {
		pendingPeerVersion++
		const closingPeer = pendingPeer
		pendingPeer = null

		try {
			closingPeer?.close()
		} catch {}
	}

	function linkedPeers() {
		return [...people.values()]
			.map((person) => person.link?.peer)
			.filter((peer): peer is Peer => peer != null)
	}

	function closePeerLinks() {
		const closingPeers = linkedPeers()

		for (const person of people.values()) {
			person.link = null
			person.mediaStream = null
		}

		for (const closingPeer of closingPeers) {
			try {
				closingPeer.close()
			} catch {}
		}
	}

	function closeAllPeers() {
		closePendingPeer()
		closePeerLinks()
	}

	function participantLink(participantId: ParticipantId) {
		return people.get(participantId)?.link ?? null
	}

	function setParticipantLink(
		participantId: ParticipantId,
		link: PeerLink | null,
	) {
		const person = people.get(participantId)
		if (person == null) return false

		person.link = link
		if (link == null) person.mediaStream = null
		return true
	}

	function replacePeople(roster: Participant[]) {
		const previous = people
		// The roster says who exists; local activity and live links stay attached by id.
		people = new Map(
			roster.map((participant): [ParticipantId, RoomPerson] => {
				const existing = previous.get(participant.id)

				return [
					participant.id,
					{
						...participant,
						activity: existing?.activity ?? emptyPersonActivity(),
						link: existing?.link ?? null,
						mediaStream: existing?.mediaStream ?? null,
					},
				]
			}),
		)

		for (const [participantId, person] of previous) {
			if (participantId === hostParticipantId || people.has(participantId)) {
				continue
			}

			person.link?.peer.close()
		}
	}

	function deletePerson(participantId: ParticipantId) {
		const person = people.get(participantId)
		people.delete(participantId)
		return person
	}

	function allocateParticipantId() {
		let id = randomParticipantId()

		while (
			id === localParticipantId ||
			id === hostParticipantId ||
			people.has(id)
		) {
			id = randomParticipantId()
		}

		return id
	}

	function resetHostParticipants() {
		pendingLocalBlip = null
		localParticipantId = randomParticipantId()
		hostParticipantId = localParticipantId
		participantSequence = 0
		people = new Map([
			[
				localParticipantId,
				createPerson({
					id: localParticipantId,
					name: 'Room host',
					role: 'host',
				}),
			],
		])
		setState('themeSeed', participantIdToString(localParticipantId))
		refreshSelfActivity()
	}

	function resetGuestParticipants(options: { keepPendingBlip?: boolean } = {}) {
		if (!options.keepPendingBlip) pendingLocalBlip = null
		localParticipantId = null
		hostParticipantId = null
		participantSequence = 0
		people = new Map()
		refreshSelfActivity()
		setState('peers', [])
	}

	function roomRoster() {
		return [...people.values()].map(publicParticipant)
	}

	function livePeerCount() {
		return livePeerLinks().length
	}

	function fileProgressState(file: FileProgress): PortraitFileState {
		const progress =
			file.size <= 0
				? 100
				: Math.min(100, Math.round((file.receivedBytes / file.size) * 100))

		return {
			id: file.id,
			name: file.name,
			progress,
			state: file.state,
			url: file.url,
		}
	}

	function activityState(activity: PersonActivity): PortraitActivityState {
		return {
			blip: activity.blip,
			files: activity.files.map(fileProgressState),
		}
	}

	function activityForParticipant(
		participantId: ParticipantId | null,
	): PortraitActivityState {
		const person = participantId == null ? null : people.get(participantId)
		return person == null
			? { blip: null, files: [] }
			: activityState(person.activity)
	}

	function refreshSelfActivity() {
		setState('selfActivity', activityForParticipant(localParticipantId))
	}

	function refreshPeerCards() {
		setState(
			'peers',
			// Self gets a richer media portrait. Everyone else is projected into plain person cards.
			[...people.values()]
				.filter((person) => person.id !== localParticipantId)
				.map((person) => ({
					activity: activityState(person.activity),
					colorSeed: participantIdToString(person.id),
					mediaStream: person.mediaStream,
					state: person.link?.live ? 'live' : 'waiting',
				})),
		)
	}

	function refreshParticipantMedia(participantId: ParticipantId) {
		if (participantId === localParticipantId) refreshSelfActivity()
		else refreshPeerCards()
	}

	function setParticipantMedia(
		participantId: ParticipantId,
		stream: MediaStream | null,
	) {
		const person = people.get(participantId)
		if (person == null) return

		person.mediaStream = stream
		refreshParticipantMedia(participantId)
	}

	function sendToParticipant(
		participantId: ParticipantId,
		message: RoomMessage,
	) {
		const link = participantLink(participantId)
		if (link == null || !link.live) return false

		return sendRoomMessage(link.peer, message)
	}

	function sendToLinks(links: PeerLink[], message: RoomMessage) {
		let sent = 0

		for (const link of links) {
			if (link.live && sendRoomMessage(link.peer, message)) sent++
		}

		return sent
	}

	function broadcast(
		message: RoomMessage,
		except: ParticipantId | null = null,
	) {
		for (const person of people.values()) {
			if (person.id === except || person.link == null || !person.link.live) {
				continue
			}

			sendRoomMessage(person.link.peer, message)
		}
	}

	function broadcastRoster() {
		broadcast({ type: 'roster', roster: roomRoster() })
	}

	function livePeerLinks() {
		return [...people.values()]
			.map((person) => person.link)
			.filter((link): link is PeerLink => link?.live === true)
	}

	function refreshParticipantActivity(participantId: ParticipantId) {
		if (participantId === localParticipantId) refreshSelfActivity()
		else refreshPeerCards()
	}

	function setParticipantBlip(participantId: ParticipantId, text: string) {
		const person = people.get(participantId)
		if (person == null) return

		const blip = text.trim()
		person.activity.blip = blip === '' ? null : blip

		refreshParticipantActivity(participantId)
	}

	function localBlip() {
		const localPerson =
			localParticipantId == null ? null : people.get(localParticipantId)
		return localPerson?.activity.blip ?? pendingLocalBlip
	}

	function applyPendingLocalBlip() {
		if (localParticipantId == null || pendingLocalBlip == null) return

		setParticipantBlip(localParticipantId, pendingLocalBlip)
		pendingLocalBlip = null
	}

	function sendLocalBlipToPeer(peer: Peer) {
		const blip = localBlip()
		if (blip == null) return false

		return sendRoomMessage(peer, { type: 'blip', text: blip })
	}

	function publishLocalBlip() {
		const blip = localBlip()
		if (blip == null) return 0

		return sendToLinks(livePeerLinks(), { type: 'blip', text: blip })
	}

	function setBlipIssue(issue: string | null) {
		setState('blipComposer', 'issue', issue)
	}

	function upsertParticipantFile(
		participantId: ParticipantId,
		file: FileProgress,
	) {
		const person = people.get(participantId)
		if (person == null) return

		const index = person.activity.files.findIndex((item) => item.id === file.id)
		if (index === -1) person.activity.files = [...person.activity.files, file]
		else {
			person.activity.files = person.activity.files.map((item, itemIndex) =>
				itemIndex === index ? file : item,
			)
		}
		refreshParticipantActivity(participantId)
	}

	function markLocalSendingFilesError() {
		const person =
			localParticipantId == null ? null : people.get(localParticipantId)
		if (person == null) return

		person.activity.files = person.activity.files.map((file) =>
			file.state === 'sending' ? { ...file, state: 'error' } : file,
		)
		refreshSelfActivity()
	}

	function disposeFileUrls() {
		for (const url of fileUrls) {
			URL.revokeObjectURL(url)
		}

		fileUrls = new Set()
	}

	function handlePeerBlip(participantId: ParticipantId, text: string) {
		setParticipantBlip(participantId, text)
	}

	function handleFileStart(
		participantId: ParticipantId,
		message: Extract<RoomMessage, { type: 'file-start' }>,
	) {
		const transfer: IncomingFileTransfer = {
			chunks: [],
			from: participantId,
			mime: message.mime,
			name: message.name,
			receivedBytes: 0,
			size: message.size,
		}

		incomingFiles.set(message.id, transfer)
		upsertParticipantFile(participantId, {
			id: message.id,
			name: message.name,
			receivedBytes: 0,
			size: message.size,
			state: 'receiving',
			url: null,
		})
	}

	function handleFileChunk(
		message: Extract<RoomMessage, { type: 'file-chunk' }>,
	) {
		const transfer = incomingFiles.get(message.id)
		if (transfer == null) return

		let bytes: Uint8Array
		try {
			bytes = base64ToBytes(message.data)
		} catch {
			upsertParticipantFile(transfer.from, {
				id: message.id,
				name: transfer.name,
				receivedBytes: transfer.receivedBytes,
				size: transfer.size,
				state: 'error',
				url: null,
			})
			incomingFiles.delete(message.id)
			return
		}

		const chunk = new Uint8Array(new ArrayBuffer(bytes.byteLength))
		chunk.set(bytes)
		transfer.chunks.push(chunk.buffer)
		transfer.receivedBytes += bytes.byteLength
		upsertParticipantFile(transfer.from, {
			id: message.id,
			name: transfer.name,
			receivedBytes: Math.min(transfer.receivedBytes, transfer.size),
			size: transfer.size,
			state: 'receiving',
			url: null,
		})
	}

	function handleFileEnd(message: Extract<RoomMessage, { type: 'file-end' }>) {
		const transfer = incomingFiles.get(message.id)
		if (transfer == null) return

		const blob = new Blob(transfer.chunks, {
			type: transfer.mime || 'application/octet-stream',
		})
		const url = URL.createObjectURL(blob)
		fileUrls.add(url)
		incomingFiles.delete(message.id)
		upsertParticipantFile(transfer.from, {
			id: message.id,
			name: transfer.name,
			receivedBytes: blob.size,
			size: transfer.size,
			state: 'ready',
			url,
		})
	}

	function handleCommonMessage(
		participantId: ParticipantId,
		message: RoomMessage,
	) {
		// Blips and files are symmetric; only connection setup needs host/guest ceremony.
		switch (message.type) {
			case 'blip':
				handlePeerBlip(participantId, message.text)
				return true
			case 'file-start':
				handleFileStart(participantId, message)
				return true
			case 'file-chunk':
				handleFileChunk(message)
				return true
			case 'file-end':
				handleFileEnd(message)
				return true
			default:
				return false
		}
	}

	function markRoomClosed() {
		closePendingPeer()
		closePeerLinks()
		setState('peers', [])
		setState('connection', {
			...state.connection,
			phase: 'closed',
			issue: null,
		})
	}

	function removePeerLink(
		participantId: ParticipantId,
		options: { participantLeft?: boolean; peer?: Peer | null } = {},
	) {
		const person = people.get(participantId)
		if (person?.link == null) return
		if (options.peer != null && person.link.peer !== options.peer) return

		person.link = null
		person.activity = emptyPersonActivity()
		person.mediaStream = null

		if (isGuestRoom() && participantId === hostParticipantId) {
			markRoomClosed()
			return
		}

		// Guests can come and go. A guest only loses the room when the host disappears.
		if (isHostRoom() || options.participantLeft) {
			people.delete(participantId)
		}

		if (isHostRoom()) {
			broadcast({ type: 'peer-left', id: participantId })
			broadcastRoster()
		}

		refreshPeerCards()

		if (isHostRoom() && livePeerCount() === 0 && pendingPeer == null) {
			void startHostInvite({ resetPeers: false })
		}
	}

	function assignGuestParticipant(): Participant {
		const id = allocateParticipantId()
		const peerNumber = ++participantSequence

		return {
			id,
			name: peerNumber === 1 ? 'Other device' : `Other device ${peerNumber}`,
			role: 'guest',
		}
	}

	function openPendingPeer(handlers: {
		debugLabel: string
		onCloseWithoutId: () => void
		onMessage: (
			peer: Peer,
			text: string,
			handle: {
				markLive: (participantId: ParticipantId) => void
				remoteId: () => ParticipantId | null
			},
		) => void
		onOpen: (
			peer: Peer,
			handle: {
				markLive: (participantId: ParticipantId) => void
				remoteId: () => ParticipantId | null
			},
		) => void
	}) {
		if (pendingPeer != null) return pendingPeer

		// Pending is the manual invite/reply socket; it becomes a person only after the room protocol says who is there.
		const version = ++pendingPeerVersion
		let remoteParticipantId: ParticipantId | null = null
		let remoteMediaStream: MediaStream | null = null
		let nextPeer: Peer | null = null

		const handle = {
			markLive: (participantId: ParticipantId) => {
				if (nextPeer == null) return

				if (
					!setParticipantLink(participantId, { peer: nextPeer, live: true })
				) {
					return
				}

				remoteParticipantId = participantId
				if (remoteMediaStream != null) {
					setParticipantMedia(participantId, remoteMediaStream)
				}
				refreshPeerCards()
			},
			remoteId: () => remoteParticipantId,
		}

		nextPeer = createPeer({
			debugLabel: handlers.debugLabel,
			onOpen: () => {
				if (
					nextPeer == null ||
					version !== pendingPeerVersion ||
					pendingPeer !== nextPeer
				) {
					return
				}

				const openedPeer = nextPeer
				pendingPeer = null
				handlers.onOpen(openedPeer, handle)
			},
			onMessage: (text) => {
				if (nextPeer == null) return
				handlers.onMessage(nextPeer, text, handle)
			},
			onRemoteMedia: (stream) => {
				remoteMediaStream = stream
				if (remoteParticipantId != null) {
					setParticipantMedia(remoteParticipantId, stream)
				}
			},
			onClose: () => {
				if (remoteParticipantId != null) {
					removePeerLink(remoteParticipantId, { peer: nextPeer })
					return
				}

				if (
					nextPeer == null ||
					version !== pendingPeerVersion ||
					pendingPeer !== nextPeer
				) {
					return
				}

				pendingPeer = null
				handlers.onCloseWithoutId()
			},
		})

		pendingPeer = nextPeer
		nextPeer.setLocalMedia(state.selfMedia.stream)
		return nextPeer
	}

	function markPeerLive(participantId: ParticipantId) {
		const link = participantLink(participantId)
		if (link == null) return

		link.live = true
		sendLocalBlipToPeer(link.peer)
		refreshPeerCards()
	}

	function handlePeerMessage(participantId: ParticipantId, text: string) {
		const message = decodeRoomMessage(text)
		if (message == null) return

		handleCommonMessage(participantId, message)
	}

	function createLinkedPeer(participantId: ParticipantId) {
		let peer: Peer | null = null

		peer = createPeer({
			debugLabel: `mesh:${participantIdToString(participantId)}`,
			onOpen: () => markPeerLive(participantId),
			onMessage: (text) => handlePeerMessage(participantId, text),
			onRemoteMedia: (stream) => setParticipantMedia(participantId, stream),
			onClose: () => removePeerLink(participantId, { peer }),
		})
		peer.setLocalMedia(state.selfMedia.stream)

		if (!setParticipantLink(participantId, { peer, live: false })) {
			peer.close()
			return null
		}

		refreshPeerCards()
		return peer
	}

	function sendToHost(message: RoomMessage) {
		if (hostParticipantId == null) return false
		return sendToParticipant(hostParticipantId, message)
	}

	async function createMeshOffer(participantId: ParticipantId) {
		if (
			!isGuestRoom() ||
			localParticipantId == null ||
			hostParticipantId == null ||
			participantLink(participantId) != null
		) {
			return
		}

		const peer = createLinkedPeer(participantId)
		if (peer == null) return

		try {
			const signal = await peer.createOffer()
			if (participantLink(participantId)?.peer !== peer) return

			sendToHost({
				type: 'peer-offer',
				from: localParticipantId,
				to: participantId,
				signal,
			})
		} catch {
			removePeerLink(participantId)
		}
	}

	function startMissingMeshOffers() {
		if (
			!isGuestRoom() ||
			localParticipantId == null ||
			hostParticipantId == null
		) {
			return
		}

		for (const participant of people.values()) {
			if (
				participant.role !== 'guest' ||
				participant.id === localParticipantId ||
				participant.id === hostParticipantId ||
				participant.link != null ||
				// Deterministic tie-break: only one guest dials for each guest-to-guest edge.
				localParticipantId < participant.id
			) {
				continue
			}

			void createMeshOffer(participant.id)
		}
	}

	async function acceptMeshOffer(
		message: Extract<RoomMessage, { type: 'peer-offer' }>,
	) {
		if (
			!isGuestRoom() ||
			localParticipantId == null ||
			message.to !== localParticipantId
		) {
			return
		}

		participantLink(message.from)?.peer.close()
		setParticipantLink(message.from, null)

		const peer = createLinkedPeer(message.from)
		if (peer == null) return

		try {
			const signal = await peer.createAnswer(message.signal)
			if (participantLink(message.from)?.peer !== peer) return

			sendToHost({
				type: 'peer-answer',
				from: localParticipantId,
				to: message.from,
				signal,
			})
		} catch {
			removePeerLink(message.from)
		}
	}

	async function acceptMeshAnswer(
		message: Extract<RoomMessage, { type: 'peer-answer' }>,
	) {
		if (localParticipantId == null || message.to !== localParticipantId) return

		const link = participantLink(message.from)
		if (link == null) return

		try {
			await link.peer.acceptAnswer(message.signal)
		} catch {
			removePeerLink(message.from)
		}
	}

	function applyRoster(roster: Participant[]) {
		if (
			hostParticipantId != null &&
			!roster.some((p) => p.id === hostParticipantId)
		) {
			markRoomClosed()
			return
		}

		replacePeople(roster)
		refreshPeerCards()
		startMissingMeshOffers()
	}

	function removeRosterParticipant(participantId: ParticipantId) {
		if (participantId === hostParticipantId) {
			markRoomClosed()
			return
		}

		const person = deletePerson(participantId)
		person?.link?.peer.close()
		refreshPeerCards()
	}

	function handleGuestMessage(
		text: string,
		handle?: { markLive: (participantId: ParticipantId) => void },
	) {
		const message = decodeRoomMessage(text)
		if (message == null) return
		const senderId = hostParticipantId
		if (senderId != null && handleCommonMessage(senderId, message)) return

		switch (message.type) {
			case 'welcome':
				// Welcome is the handoff from paste-code UX into actual room membership.
				localParticipantId = message.selfId
				hostParticipantId = message.hostId
				clearInviteHash()
				setState('themeSeed', participantIdToString(message.hostId))
				replacePeople(message.roster)
				applyPendingLocalBlip()
				handle?.markLive(message.hostId)
				setState('connection', 'phase', 'connected')
				setState('connection', 'issue', null)
				refreshSelfActivity()
				refreshPeerCards()
				publishLocalBlip()
				startMissingMeshOffers()
				break
			case 'roster':
				applyRoster(message.roster)
				break
			case 'peer-offer':
				void acceptMeshOffer(message)
				break
			case 'peer-answer':
				void acceptMeshAnswer(message)
				break
			case 'peer-left':
				removeRosterParticipant(message.id)
				break
			case 'file-chunk':
			case 'file-end':
			case 'file-start':
			case 'hello':
			case 'blip':
				break
		}
	}

	function handleHostMessage(participantId: ParticipantId, text: string) {
		const message = decodeRoomMessage(text)
		if (message == null) return
		if (handleCommonMessage(participantId, message)) return

		switch (message.type) {
			case 'hello':
				if (localParticipantId == null) return
				sendToParticipant(participantId, {
					type: 'welcome',
					hostId: localParticipantId,
					selfId: participantId,
					roster: roomRoster(),
				})
				break
			case 'peer-offer':
			case 'peer-answer':
				// The host introduces guests; it should not become the long-term transport.
				if (message.to === localParticipantId) return
				sendToParticipant(message.to, { ...message, from: participantId })
				break
			case 'peer-left':
			case 'file-chunk':
			case 'file-end':
			case 'file-start':
			case 'roster':
			case 'blip':
			case 'welcome':
				break
		}
	}

	function markHostConnected(
		peer: Peer,
		markLive: (participantId: ParticipantId) => void,
	) {
		const participant = assignGuestParticipant()
		people.set(participant.id, createPerson(participant))
		markLive(participant.id)

		setState('connection', 'issue', null)
		setState('connection', 'replyText', '')

		if (localParticipantId != null) {
			sendRoomMessage(peer, {
				type: 'welcome',
				hostId: localParticipantId,
				selfId: participant.id,
				roster: roomRoster(),
			})
			sendLocalBlipToPeer(peer)
		}

		broadcastRoster()
		// Keep the host ready for the next person without asking them to regenerate by hand.
		void startHostInvite({ resetPeers: false })
	}

	async function startHostInvite(
		options: { resetPeers: boolean } = { resetPeers: true },
	) {
		const version = ++connectionVersion

		try {
			closePendingPeer()

			if (options.resetPeers) {
				closePeerLinks()
				resetHostParticipants()
				clearInviteHash()
				setState('blipComposer', emptyBlipComposer())
				setState('peers', [])
			} else if (localParticipantId == null || hostParticipantId == null) {
				resetHostParticipants()
			}

			setState('connection', emptyHostConnection())

			const nextPeer = openPendingPeer({
				debugLabel: options.resetPeers ? 'host:invite' : 'host:next-invite',
				onOpen: (peer, handle) => {
					markHostConnected(peer, handle.markLive)
				},
				onMessage: (_peer, text, handle) => {
					const participantId = handle.remoteId()
					if (participantId == null) return

					handleHostMessage(participantId, text)
				},
				onCloseWithoutId: () => {
					if (isHostRoom()) {
						void startHostInvite({ resetPeers: false })
					}
				},
			})
			const inviteCode = await nextPeer.createOffer()
			if (version !== connectionVersion || pendingPeer !== nextPeer) return

			const inviteLink = inviteLinkFromCode(inviteCode)
			setState('connection', {
				...emptyHostConnection(),
				phase: 'invite-ready',
				inviteLink,
			})
		} catch {
			if (version !== connectionVersion) return
			setState('connection', 'issue', 'Could not create an invite.')
		}
	}

	function becomeGuest() {
		connectionVersion++
		closeAllPeers()
		clearInviteHash()
		resetGuestParticipants()
		setState('connection', emptyGuestConnection())
		setState('blipComposer', emptyBlipComposer())
	}

	async function createReply(inviteText = state.connection.inviteText) {
		const inviteInput = inviteText.trim()
		const inviteCode = inviteCodeFromInput(inviteInput)
		if (inviteCode === '') return

		const version = ++connectionVersion

		try {
			closeAllPeers()
			resetGuestParticipants({ keepPendingBlip: true })
			setState('connection', {
				...emptyGuestConnection(),
				phase: 'creating-reply',
				inviteText: inviteInput,
			})

			const nextPeer = openPendingPeer({
				debugLabel: 'guest:reply',
				onOpen: (peer) => {
					sendRoomMessage(peer, { type: 'hello' })
				},
				onMessage: (_peer, text, handle) => {
					handleGuestMessage(text, handle)
				},
				onCloseWithoutId: () => {
					markRoomClosed()
				},
			})
			const replyCode = await nextPeer.createAnswer(inviteCode)
			if (version !== connectionVersion || pendingPeer !== nextPeer) return

			setState('connection', {
				...emptyGuestConnection(),
				phase: 'reply-ready',
				inviteText: inviteInput,
				replyCode,
			})
		} catch {
			if (version !== connectionVersion) return
			closeAllPeers()
			setState('connection', {
				...emptyGuestConnection(),
				inviteText: inviteInput,
				issue: 'That invite did not work. Paste a fresh invite and try again.',
			})
		}
	}

	async function acceptReply(replyText = state.connection.replyText) {
		const replyCode = replyText.trim()
		if (replyCode === '' || pendingPeer == null) return

		const version = connectionVersion
		const answeringPeer = pendingPeer

		try {
			setState('connection', 'replyText', replyCode)
			setState('connection', 'phase', 'accepting-reply')
			setState('connection', 'issue', null)

			await answeringPeer.acceptAnswer(replyCode)
			if (version !== connectionVersion) return
		} catch {
			if (version !== connectionVersion) return
			setState('connection', 'phase', 'invite-ready')
			setState(
				'connection',
				'issue',
				'That reply did not work. Ask for a fresh reply or regenerate the invite.',
			)
		}
	}

	function sendBlip(text = state.blipComposer.text) {
		const blip = text.trim()
		const currentBlip = localBlip()
		if (blip === '' && currentBlip == null) return

		if (localParticipantId == null) {
			pendingLocalBlip = blip === '' ? null : blip
		} else {
			pendingLocalBlip = null
			setParticipantBlip(localParticipantId, blip)
		}

		sendToLinks(livePeerLinks(), { type: 'blip', text: blip })
		setState('blipComposer', 'text', blip)
		setBlipIssue(null)
	}

	function publishSelfMedia(stream: MediaStream | null) {
		const peers = linkedPeers()
		roomDebug('media.publish', {
			linkedPeers: peers.length,
			pendingPeer: pendingPeer != null,
			streamId: stream?.id ?? null,
			tracks: mediaTracks(stream),
		})

		for (const peer of peers) {
			peer.setLocalMedia(stream)
		}

		pendingPeer?.setLocalMedia(stream)
	}

	async function sendFileToPeers(file: File, peers: PeerLink[]) {
		const id = randomTransferId()

		if (localParticipantId == null) return

		// File chips appear immediately; transfer is best understood as a promise already in motion.
		upsertParticipantFile(localParticipantId, {
			id,
			name: file.name,
			receivedBytes: 0,
			size: file.size,
			state: 'sending',
			url: null,
		})
		setBlipIssue(null)

		if (
			sendToLinks(peers, {
				id,
				mime: file.type,
				name: file.name,
				size: file.size,
				type: 'file-start',
			}) === 0
		) {
			throw new Error('No open file channels')
		}

		for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
			const chunk = file.slice(offset, offset + FILE_CHUNK_BYTES)
			const bytes = new Uint8Array(await chunk.arrayBuffer())
			const sent = sendToLinks(peers, {
				data: bytesToBase64(bytes),
				id,
				type: 'file-chunk',
			})
			if (sent === 0) throw new Error('File channel closed')

			upsertParticipantFile(localParticipantId, {
				id,
				name: file.name,
				receivedBytes: offset + bytes.byteLength,
				size: file.size,
				state: 'sending',
				url: null,
			})
			await Promise.all(
				peers.map((link) =>
					link.peer.waitForBufferBelow(FILE_BUFFER_LOW_BYTES),
				),
			)
		}

		sendToLinks(peers, { id, type: 'file-end' })
		upsertParticipantFile(localParticipantId, {
			id,
			name: file.name,
			receivedBytes: file.size,
			size: file.size,
			state: 'ready',
			url: null,
		})
	}

	async function sendFiles(files: File[]) {
		if (files.length === 0) return

		const peers = livePeerLinks()
		if (peers.length === 0) {
			setBlipIssue('Connect another device before sending files.')
			return
		}

		try {
			for (const file of files) {
				await sendFileToPeers(file, peers)
			}
		} catch {
			markLocalSendingFilesError()
			setBlipIssue('File transfer stopped before it finished.')
		}
	}

	function disposeSelfMedia() {
		selfMediaVersion++
		publishSelfMedia(null)
		stopSelfMedia(state.selfMedia)
		setState('selfMedia', emptySelfMedia())
	}

	async function enableSelfMedia() {
		if (state.selfMedia.status === 'requesting') return

		// Camera permission belongs to the self portrait, not to page load.
		const version = ++selfMediaVersion
		publishSelfMedia(null)
		stopSelfMedia(state.selfMedia)
		setState('selfMedia', {
			...emptySelfMedia(),
			status: 'requesting',
		})

		const selfMedia = await captureSelfMedia()
		if (version !== selfMediaVersion) {
			stopSelfMedia(selfMedia)
			return
		}

		setState('selfMedia', selfMedia)
		publishSelfMedia(selfMedia.stream)
	}

	function setTracksEnabled(kind: 'audio' | 'video', enabled: boolean) {
		if (!setSelfMediaTracksEnabled(state.selfMedia, kind, enabled)) return
		roomDebug('media.track-enabled', { enabled, kind })

		if (kind === 'video') setState('selfMedia', 'cameraEnabled', enabled)
		else setState('selfMedia', 'microphoneEnabled', enabled)
	}

	function toggleCamera() {
		if (!state.selfMedia.cameraAvailable) return
		setTracksEnabled('video', !state.selfMedia.cameraEnabled)
	}

	function toggleMicrophone() {
		if (!state.selfMedia.microphoneAvailable) return
		setTracksEnabled('audio', !state.selfMedia.microphoneEnabled)
	}

	onMount(() => {
		const inviteCode = readInviteFromHash()

		if (inviteCode != null) {
			void createReply(inviteCode)
			return
		}

		void startHostInvite()
	})

	onCleanup(() => {
		closeAllPeers()
		disposeFileUrls()
		disposeSelfMedia()
	})

	return {
		state,
		becomeGuest,
		becomeHost: () => {
			void startHostInvite()
		},
		copyInviteLink: () => void copyText(state.connection.inviteLink),
		copyReplyCode: () => void copyText(state.connection.replyCode),
		createReply: (inviteText?: string) => void createReply(inviteText),
		enableSelfMedia: () => void enableSelfMedia(),
		acceptReply: (replyText?: string) => void acceptReply(replyText),
		sendFiles: (files: File[]) => void sendFiles(files),
		sendBlip: (text?: string) => sendBlip(text),
		setInviteText: (inviteText: string) => {
			setState('connection', 'inviteText', inviteText)
			setState('connection', 'issue', null)
		},
		setReplyText: (replyText: string) => {
			setState('connection', 'replyText', replyText)
			setState('connection', 'issue', null)
		},
		setBlipText: (text: string) => {
			setState('blipComposer', 'text', text)
			setState('blipComposer', 'issue', null)
		},
		toggleCamera,
		toggleMicrophone,
	}
}
