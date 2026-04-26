import { createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { base64ToBytes, bytesToBase64 } from './binary'
import {
	decodePacket,
	encodePacket,
	type Packet,
	type Participant,
	type ParticipantId,
	participantIdToString,
} from './protocol'
import {
	createIncomingFileTransfer,
	FILE_BUFFER_LOW_BYTES,
	FILE_CHUNK_BYTES,
	type FileProgress,
	fileProgressState,
	type IncomingFileTransfer,
	randomTransferId,
} from './room/activity'
import { mediaTracks, roomDebug } from './room/debug'
import {
	emptyBlipComposer,
	emptyGuestConnection,
	emptyHostConnection,
	emptyRoomState,
} from './room/initial-state'
import {
	clearInviteHash,
	copyText,
	inviteCodeFromInput,
	inviteLinkFromCode,
	readInviteFromHash,
} from './room/invite'
import {
	emptyParticipantActivity,
	mergeParticipant,
	type ParticipantKey,
	participantKey,
	type RoomParticipant,
	randomParticipantId,
	rosterParticipant,
} from './room/participant'
import {
	captureSelfMedia,
	emptySelfMedia,
	setSelfMediaTracksEnabled,
	stopSelfMedia,
} from './self-media'
import type { PeerState, PortraitFileState } from './state'
import { createPeer, type Peer } from './webrtc'

type LinkId = string

type LinkRole = 'guest-rendezvous' | 'host-rendezvous' | 'mesh'

type RoomLink = {
	id: LinkId
	live: boolean
	mediaStream: MediaStream | null
	peer: Peer
	remoteId: ParticipantId | null
	role: LinkRole
}

type RoomPeer = RoomParticipant & {
	mediaStream: MediaStream | null
	state: PeerState
}

function packetDebugDetails(packet: Packet) {
	if (packet.type === 'file-chunk') return null

	return {
		from: 'from' in packet ? participantIdToString(packet.from) : null,
		id:
			'id' in packet
				? typeof packet.id === 'bigint'
					? participantIdToString(packet.id)
					: packet.id
				: null,
		to: 'to' in packet ? participantIdToString(packet.to) : null,
		type: packet.type,
	}
}

function logPacket(
	event: string,
	packet: Packet,
	details: Record<string, unknown> = {},
) {
	const packetDetails = packetDebugDetails(packet)
	if (packetDetails == null) return

	roomDebug(event, { ...details, ...packetDetails })
}

function sendPacket(peer: Peer, packet: Packet) {
	logPacket('packet.send', packet)
	return peer.send(encodePacket(packet))
}

export function createRoom() {
	const incomingFiles = new Map<string, IncomingFileTransfer>()
	let fileUrls = new Set<string>()
	let pendingLocalBlip: string | null = null
	// Host identity is the closest thing we have to room identity, so it also paints the room.
	let localParticipantId: ParticipantId | null = randomParticipantId()
	let hostParticipantId: ParticipantId | null = localParticipantId
	let connectionVersion = 0
	let linkSequence = 0
	let selfMediaVersion = 0
	const hostParticipant = mergeParticipant({ id: localParticipantId })
	const links = new Map<LinkId, RoomLink>()
	const [linkRevision, setLinkRevision] = createSignal(0)
	const [participantKeys, setParticipantKeys] = createSignal<ParticipantKey[]>([
		hostParticipant.id,
	])
	const [localKey, setLocalKey] = createSignal<ParticipantKey | null>(
		hostParticipant.id,
	)
	const [participants, setParticipants] = createStore<
		Partial<Record<ParticipantKey, RoomParticipant>>
	>({
		[hostParticipant.id]: hostParticipant,
	})

	const [state, setState] = createStore(emptyRoomState(hostParticipant.id))

	const peerKeys = createMemo(() => {
		const local = localKey()
		return participantKeys().filter((key) => key !== local)
	})

	const selfActivity = createMemo(() => {
		const key = localKey()
		return key == null
			? emptyParticipantActivity()
			: (participantByKey(key)?.activity ?? emptyParticipantActivity())
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

	function participantByKey(key: ParticipantKey) {
		return participants[key] ?? null
	}

	function touchLinks() {
		setLinkRevision((revision) => revision + 1)
	}

	function peerByKey(key: ParticipantKey): RoomPeer | null {
		const participant = participantByKey(key)
		if (participant == null) return null

		// links is intentionally a transport map; this signal bridges it into Solid projections.
		linkRevision()
		const link = linkByParticipantKey(key)
		return {
			...participant,
			mediaStream: link?.mediaStream ?? null,
			state: link?.live ? 'live' : 'waiting',
		}
	}

	function participantById(participantId: ParticipantId | null) {
		return participantId == null
			? null
			: participantByKey(participantKey(participantId))
	}

	function nextLinkId(role: LinkRole): LinkId {
		linkSequence++
		return `${role}:${linkSequence}`
	}

	function isRendezvousLink(link: RoomLink) {
		return link.role === 'host-rendezvous' || link.role === 'guest-rendezvous'
	}

	function currentRendezvousLink(role?: LinkRole) {
		for (const link of links.values()) {
			if (!isRendezvousLink(link)) continue
			if (role != null && link.role !== role) continue
			if (link.remoteId == null) return link
		}

		return null
	}

	function linkByParticipantKey(key: ParticipantKey) {
		for (const link of links.values()) {
			if (link.remoteId != null && participantKey(link.remoteId) === key) {
				return link
			}
		}

		return null
	}

	function linkedPeers() {
		return [...links.values()].map((link) => link.peer)
	}

	function removeLink(link: RoomLink) {
		if (links.get(link.id) !== link) return

		link.live = false
		links.delete(link.id)
		touchLinks()
	}

	function closeLink(link: RoomLink) {
		removeLink(link)

		try {
			link.peer.close()
		} catch {}
	}

	function closeRendezvousLink(role?: LinkRole) {
		const link = currentRendezvousLink(role)
		if (link != null) closeLink(link)
	}

	function closeAllLinks() {
		const closingLinks = [...links.values()]
		links.clear()
		for (const link of closingLinks) link.live = false
		touchLinks()

		for (const link of closingLinks) {
			try {
				link.peer.close()
			} catch {}
		}
	}

	function closeAllPeers() {
		closeAllLinks()
	}

	function participantLink(participantId: ParticipantId) {
		return linkByParticipantKey(participantKey(participantId))
	}

	function adoptLink(link: RoomLink, participantId: ParticipantId) {
		if (links.get(link.id) !== link) return false
		if (link.remoteId != null && link.remoteId !== participantId) return false

		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return false

		const existing = linkByParticipantKey(key)
		if (existing != null && existing !== link) closeLink(existing)

		link.remoteId = participantId
		touchLinks()
		return true
	}

	function replaceParticipants(roster: Participant[]) {
		const nextKeys = roster.map((person) => participantKey(person.id))
		const nextKeySet = new Set(nextKeys)
		const host =
			hostParticipantId == null ? null : participantKey(hostParticipantId)
		const nextParticipants: Partial<Record<ParticipantKey, RoomParticipant>> =
			{}

		for (const key of participantKeys()) {
			if (key === host || nextKeySet.has(key)) {
				continue
			}

			const link = linkByParticipantKey(key)
			if (link != null) closeLink(link)
		}

		for (const person of roster) {
			const key = participantKey(person.id)
			const existing = participants[key]
			nextParticipants[key] = mergeParticipant(person, existing)
		}

		setParticipants(reconcile(nextParticipants))
		setParticipantKeys(nextKeys)
	}

	function deleteParticipant(participantId: ParticipantId) {
		const key = participantKey(participantId)
		const link = participantLink(participantId)

		if (link != null) removeLink(link)
		setParticipantKeys((keys) => keys.filter((item) => item !== key))
		setParticipants(key, undefined)

		return link
	}

	function allocateParticipantId() {
		let id = randomParticipantId()

		while (
			id === localParticipantId ||
			id === hostParticipantId ||
			participants[participantKey(id)] != null
		) {
			id = randomParticipantId()
		}

		return id
	}

	function resetHostParticipants() {
		pendingLocalBlip = null
		localParticipantId = randomParticipantId()
		hostParticipantId = localParticipantId
		closeAllLinks()

		const host = mergeParticipant({ id: localParticipantId })
		setParticipants(reconcile({ [host.id]: host }))
		setParticipantKeys([host.id])
		setLocalKey(host.id)
		setState('themeSeed', host.id)
	}

	function resetGuestParticipants(options: { keepPendingBlip?: boolean } = {}) {
		if (!options.keepPendingBlip) pendingLocalBlip = null
		localParticipantId = null
		hostParticipantId = null
		closeAllLinks()
		setParticipants(reconcile({}))
		setParticipantKeys([])
		setLocalKey(null)
	}

	function roomRoster() {
		return participantKeys()
			.map((key) => participants[key])
			.filter((person): person is RoomParticipant => person != null)
			.map(rosterParticipant)
	}

	function livePeerCount() {
		return livePeerLinks().length
	}

	function sendToParticipant(participantId: ParticipantId, packet: Packet) {
		const link = participantLink(participantId)
		if (link == null || !link.live) return false

		return sendPacket(link.peer, packet)
	}

	function sendToLinks(links: RoomLink[], packet: Packet) {
		let sent = 0

		for (const link of links) {
			if (link.live && sendPacket(link.peer, packet)) sent++
		}

		return sent
	}

	function broadcastPacket(
		packet: Packet,
		except: ParticipantId | null = null,
	) {
		const exceptKey = except == null ? null : participantKey(except)

		for (const key of participantKeys()) {
			const link = linkByParticipantKey(key)
			if (key === exceptKey || link == null || !link.live) {
				continue
			}

			sendPacket(link.peer, packet)
		}
	}

	function broadcastMembershipChange(options: { left?: ParticipantId } = {}) {
		// Membership is a protocol commit, not any participant-store mutation.
		if (options.left != null) {
			broadcastPacket({ type: 'peer-left', id: options.left })
		}
		broadcastPacket({ type: 'roster', roster: roomRoster() })
	}

	function livePeerLinks() {
		return [...links.values()].filter(
			(link) => link.live && link.remoteId != null,
		)
	}

	function setParticipantBlip(participantId: ParticipantId, text: string) {
		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return

		const blip = text.trim()
		setParticipants(key, 'activity', 'blip', blip === '' ? null : blip)
	}

	function localBlip() {
		return (
			participantById(localParticipantId)?.activity.blip ?? pendingLocalBlip
		)
	}

	function applyPendingLocalBlip() {
		if (localParticipantId == null || pendingLocalBlip == null) return

		setParticipantBlip(localParticipantId, pendingLocalBlip)
		pendingLocalBlip = null
	}

	function sendLocalBlipToPeer(peer: Peer) {
		const blip = localBlip()
		if (blip == null) return false

		return sendPacket(peer, { type: 'blip', text: blip })
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
		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return

		const nextFile = fileProgressState(file)
		setParticipants(key, 'activity', 'files', (files) => {
			const index = files.findIndex((item) => item.id === file.id)
			if (index === -1) return [...files, nextFile]

			return files.map((item, itemIndex) =>
				itemIndex === index ? nextFile : item,
			)
		})
	}

	function markLocalSendingFilesError() {
		const key = localKey()
		if (key == null) return

		const person = participants[key]
		if (person == null) return

		setParticipants(key, 'activity', 'files', (files: PortraitFileState[]) =>
			files.map((file) =>
				file.state === 'sending' ? { ...file, state: 'error' } : file,
			),
		)
	}

	function disposeFileUrls() {
		for (const url of fileUrls) {
			URL.revokeObjectURL(url)
		}

		fileUrls = new Set()
	}

	function handlePeerBlip(participantId: ParticipantId, text: string) {
		roomDebug('blip.receive', {
			empty: text.trim() === '',
			from: participantIdToString(participantId),
			textLength: text.length,
		})
		setParticipantBlip(participantId, text)
	}

	function handleFileStart(
		participantId: ParticipantId,
		message: Extract<Packet, { type: 'file-start' }>,
	) {
		const transfer = createIncomingFileTransfer(participantId, message)

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

	function handleFileChunk(message: Extract<Packet, { type: 'file-chunk' }>) {
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

	function handleFileEnd(message: Extract<Packet, { type: 'file-end' }>) {
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

	function handleCommonMessage(participantId: ParticipantId, message: Packet) {
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

	function clearPeerParticipants() {
		const local = localKey()
		const self = local == null ? null : participants[local]

		setParticipants(
			reconcile(local != null && self != null ? { [local]: self } : {}),
		)
		setParticipantKeys(local == null ? [] : [local])
	}

	function markRoomClosed() {
		closeAllLinks()
		clearPeerParticipants()
		setState('connection', {
			...state.connection,
			phase: 'closed',
			issue: null,
		})
	}

	function removeParticipantLink(
		participantId: ParticipantId,
		options: { peer?: Peer | null } = {},
	) {
		const key = participantKey(participantId)
		const person = participants[key]
		const link = participantLink(participantId)
		if (link == null) return
		if (options.peer != null && link.peer !== options.peer) return

		removeLink(link)
		if (person != null) {
			setParticipants(key, 'activity', emptyParticipantActivity())
		}

		if (isGuestRoom() && participantId === hostParticipantId) {
			markRoomClosed()
			return
		}

		// Guests can come and go. A guest only loses the room when the host disappears.
		if (isHostRoom()) {
			setParticipantKeys((keys) => keys.filter((item) => item !== key))
			setParticipants(key, undefined)
		}

		if (isHostRoom()) {
			broadcastMembershipChange({ left: participantId })
		}

		if (
			isHostRoom() &&
			livePeerCount() === 0 &&
			currentRendezvousLink('host-rendezvous') == null
		) {
			void startHostInvite({ resetPeers: false })
		}
	}

	function assignGuestParticipant(): Participant {
		return { id: allocateParticipantId() }
	}

	function createLink(
		role: LinkRole,
		debugLabel: string,
		remoteId: ParticipantId | null = null,
	) {
		const id = nextLinkId(role)
		const peer = createPeer({
			debugLabel,
			onOpen: () => handleLinkOpen(id),
			onMessage: (text) => handleLinkMessage(id, text),
			onRemoteMedia: (stream) => {
				const link = links.get(id)
				if (link == null) return

				link.mediaStream = stream
				touchLinks()
			},
			onClose: () => handleLinkClose(id),
		})

		const link: RoomLink = {
			id,
			live: false,
			mediaStream: null,
			peer,
			remoteId,
			role,
		}
		links.set(id, link)
		touchLinks()
		peer.setLocalMedia(state.selfMedia.stream)
		return link
	}

	function handleLinkOpen(linkId: LinkId) {
		const link = links.get(linkId)
		if (link == null) return

		link.live = true
		touchLinks()

		if (link.role === 'guest-rendezvous') {
			sendPacket(link.peer, { type: 'hello' })
			return
		}

		if (link.remoteId != null) sendLocalBlipToPeer(link.peer)
	}

	function handleLinkClose(linkId: LinkId) {
		const link = links.get(linkId)
		if (link == null) return

		if (link.remoteId != null) {
			removeParticipantLink(link.remoteId, { peer: link.peer })
			return
		}

		removeLink(link)
		if (link.role === 'host-rendezvous' && isHostRoom()) {
			void startHostInvite({ resetPeers: false })
		} else if (link.role === 'guest-rendezvous') {
			markRoomClosed()
		}
	}

	function handleLinkMessage(linkId: LinkId, text: string) {
		const link = links.get(linkId)
		if (link == null) return

		const message = decodePacket(text)
		if (message == null) return

		switch (link.role) {
			case 'host-rendezvous':
				handleHostRendezvousMessage(link, message)
				break
			case 'guest-rendezvous':
				handleGuestMessage(link, message)
				break
			case 'mesh':
				handlePeerMessage(link, message)
				break
		}
	}

	function handlePeerMessage(link: RoomLink, message: Packet) {
		if (link.remoteId == null) return

		logPacket('packet.receive', message, {
			fromPeer: participantIdToString(link.remoteId),
		})
		handleCommonMessage(link.remoteId, message)
	}

	function createMeshLink(participantId: ParticipantId) {
		const link = createLink(
			'mesh',
			`mesh:${participantIdToString(participantId)}`,
			participantId,
		)

		if (participantById(participantId) == null) {
			closeLink(link)
			return null
		}

		return link
	}

	function sendToHost(message: Packet) {
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

		const link = createMeshLink(participantId)
		if (link == null) return

		try {
			const signal = await link.peer.createOffer()
			if (participantLink(participantId) !== link) return

			sendToHost({
				type: 'peer-offer',
				from: localParticipantId,
				to: participantId,
				signal,
			})
		} catch {
			removeParticipantLink(participantId, { peer: link.peer })
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

		for (const key of participantKeys()) {
			const participant = participants[key]
			if (participant == null) continue

			if (
				participant.participantId === localParticipantId ||
				participant.participantId === hostParticipantId ||
				linkByParticipantKey(key) != null ||
				// Deterministic tie-break: only one guest dials for each guest-to-guest edge.
				localParticipantId < participant.participantId
			) {
				continue
			}

			void createMeshOffer(participant.participantId)
		}
	}

	async function acceptMeshOffer(
		message: Extract<Packet, { type: 'peer-offer' }>,
	) {
		if (
			!isGuestRoom() ||
			localParticipantId == null ||
			message.to !== localParticipantId
		) {
			return
		}

		const existing = participantLink(message.from)
		if (existing != null) closeLink(existing)

		const link = createMeshLink(message.from)
		if (link == null) return

		try {
			const signal = await link.peer.createAnswer(message.signal)
			if (participantLink(message.from) !== link) return

			sendToHost({
				type: 'peer-answer',
				from: localParticipantId,
				to: message.from,
				signal,
			})
		} catch {
			removeParticipantLink(message.from, { peer: link.peer })
		}
	}

	async function acceptMeshAnswer(
		message: Extract<Packet, { type: 'peer-answer' }>,
	) {
		if (localParticipantId == null || message.to !== localParticipantId) return

		const link = participantLink(message.from)
		if (link == null) return

		try {
			await link.peer.acceptAnswer(message.signal)
		} catch {
			removeParticipantLink(message.from, { peer: link.peer })
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

		replaceParticipants(roster)
		startMissingMeshOffers()
	}

	function removeRosterParticipant(participantId: ParticipantId) {
		if (participantId === hostParticipantId) {
			markRoomClosed()
			return
		}

		deleteParticipant(participantId)?.peer.close()
	}

	function handleGuestMessage(link: RoomLink, message: Packet) {
		const senderId = hostParticipantId ?? link.remoteId
		logPacket('packet.receive', message, {
			fromPeer: senderId == null ? null : participantIdToString(senderId),
			side: 'guest',
		})
		if (senderId != null && handleCommonMessage(senderId, message)) return

		switch (message.type) {
			case 'welcome':
				// Welcome is the handoff from paste-code UX into actual room membership.
				localParticipantId = message.selfId
				hostParticipantId = message.hostId
				clearInviteHash()
				setState('themeSeed', participantIdToString(message.hostId))
				setLocalKey(participantKey(message.selfId))
				replaceParticipants(message.roster)
				applyPendingLocalBlip()
				if (!adoptLink(link, message.hostId)) {
					markRoomClosed()
					return
				}
				setState('connection', 'phase', 'connected')
				setState('connection', 'issue', null)
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

	function sendHostWelcome(participantId: ParticipantId) {
		if (localParticipantId == null) return
		sendToParticipant(participantId, {
			type: 'welcome',
			hostId: localParticipantId,
			selfId: participantId,
			roster: roomRoster(),
		})
		const link = participantLink(participantId)
		if (link != null) sendLocalBlipToPeer(link.peer)
	}

	function handleHostPacket(participantId: ParticipantId, message: Packet) {
		if (handleCommonMessage(participantId, message)) return
		switch (message.type) {
			case 'hello':
				sendHostWelcome(participantId)
				broadcastMembershipChange()
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

	function admitHostRendezvous(link: RoomLink) {
		const existingId = link.remoteId
		if (existingId != null) {
			return { fresh: false, participantId: existingId }
		}

		const participant = assignGuestParticipant()
		const person = mergeParticipant(participant)
		setParticipants(person.id, person)
		setParticipantKeys((keys) =>
			keys.includes(person.id) ? keys : [...keys, person.id],
		)
		if (!adoptLink(link, participant.id)) {
			deleteParticipant(participant.id)
			return null
		}

		setState('connection', 'issue', null)
		setState('connection', 'replyText', '')
		return { fresh: true, participantId: participant.id }
	}

	function handleHostRendezvousMessage(link: RoomLink, message: Packet) {
		let participantId = link.remoteId
		let fresh = false
		if (participantId == null && message.type === 'hello') {
			const admission = admitHostRendezvous(link)
			if (admission == null) return

			participantId = admission.participantId
			fresh = admission.fresh
		}

		logPacket('packet.receive', message, {
			fromPeer:
				participantId == null ? null : participantIdToString(participantId),
			side: 'host',
		})
		if (participantId == null) return

		handleHostPacket(participantId, message)
		if (fresh) {
			// Keep the host ready for the next person only after this peer joined the room protocol.
			void startHostInvite({ resetPeers: false })
		}
	}

	async function startHostInvite(
		options: { resetPeers: boolean } = { resetPeers: true },
	) {
		const version = ++connectionVersion

		try {
			closeRendezvousLink('host-rendezvous')

			if (options.resetPeers) {
				resetHostParticipants()
				clearInviteHash()
				setState('blipComposer', emptyBlipComposer())
			} else if (localParticipantId == null || hostParticipantId == null) {
				resetHostParticipants()
			}

			setState('connection', emptyHostConnection())

			const nextLink = createLink(
				'host-rendezvous',
				options.resetPeers ? 'host:invite' : 'host:next-invite',
			)
			const inviteCode = await nextLink.peer.createOffer()
			if (
				version !== connectionVersion ||
				currentRendezvousLink('host-rendezvous') !== nextLink
			) {
				return
			}

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

			const nextLink = createLink('guest-rendezvous', 'guest:reply')
			const replyCode = await nextLink.peer.createAnswer(inviteCode)
			if (
				version !== connectionVersion ||
				currentRendezvousLink('guest-rendezvous') !== nextLink
			) {
				return
			}

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
		const answeringLink = currentRendezvousLink('host-rendezvous')
		if (replyCode === '' || answeringLink == null) return

		const version = connectionVersion

		try {
			setState('connection', 'replyText', replyCode)
			setState('connection', 'phase', 'accepting-reply')
			setState('connection', 'issue', null)

			await answeringLink.peer.acceptAnswer(replyCode)
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

		const sent = sendToLinks(livePeerLinks(), { type: 'blip', text: blip })
		roomDebug('blip.send', {
			empty: blip === '',
			participant:
				localParticipantId == null
					? null
					: participantIdToString(localParticipantId),
			sent,
			textLength: blip.length,
		})
		setState('blipComposer', 'text', blip)
		setBlipIssue(null)
	}

	function publishSelfMedia(stream: MediaStream | null) {
		const peers = linkedPeers()
		const linkCount = links.size
		roomDebug('media.publish', {
			links: linkCount,
			linkedPeers: peers.length,
			unidentifiedLinks: [...links.values()].filter(
				(link) => link.remoteId == null,
			).length,
			streamId: stream?.id ?? null,
			tracks: mediaTracks(stream),
		})

		for (const peer of peers) {
			peer.setLocalMedia(stream)
		}
	}

	async function sendFileToPeers(file: File, peers: RoomLink[]) {
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
		roomDebug('media.enable.start')
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

		roomDebug('media.enable.done', {
			status: selfMedia.status,
			streamId: selfMedia.stream?.id ?? null,
			tracks: mediaTracks(selfMedia.stream),
		})
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

	const actions = {
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

	return {
		actions,
		state,
		participant: participantByKey,
		peer: peerByKey,
		peerKeys,
		selfActivity,
	}
}

export type RoomHandle = ReturnType<typeof createRoom>
export type { RoomState } from './room/initial-state'
