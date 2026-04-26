import { createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { base64ToBytes, bytesToBase64 } from './binary'
import { errorLog, infoLog, warnLog } from './log'
import {
	decodePacket,
	encodePacket,
	type Packet,
	type Participant,
	type ParticipantId,
	participantIdToString,
} from './protocol'
import {
	deriveRoomKeys,
	type RoomKeys,
	randomNonce,
	signRoomAuth,
	verifyRoomAuth,
} from './rendezvous/crypto'
import { type RoomSecret, randomRoomSecret } from './rendezvous/secret'
import {
	createTrackerRendezvous,
	type TrackerRendezvous,
	type TrackerStatus,
} from './rendezvous/tracker'
import {
	createIncomingFileTransfer,
	FILE_BUFFER_LOW_BYTES,
	FILE_CHUNK_BYTES,
	type FileProgress,
	fileProgressState,
	type IncomingFileTransfer,
	randomTransferId,
} from './room/activity'
import {
	closedConnection,
	emptyBlipComposer,
	emptyGuestConnection,
	emptyHostConnection,
	emptyRoomState,
} from './room/initial-state'
import {
	autoInviteLinkFromSecret,
	clearInviteHash,
	copyText,
	inviteFromInput,
	manualInviteLinkFromCode,
	readInviteFromHash,
} from './room/invite'
import {
	findParticipantLink,
	findRendezvousLink,
	type LinkAuthState,
	type LinkId,
	type LinkRole,
	type LinkSource,
	liveIdentifiedLinks,
	type RoomLink,
} from './room/link'
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
	type SelfMedia,
	setSelfMediaTracksEnabled,
	stopSelfMedia,
} from './self-media'
import { decodeSignal, encodeSignal, type SignalDescription } from './signal'
import type { PeerMediaState, PeerState, PortraitFileState } from './state'
import { createPeer, type Peer } from './webrtc'

type RoomPeer = RoomParticipant & {
	mediaState: PeerMediaState | null
	mediaStream: MediaStream | null
	state: PeerState
}

const sendPacket = (peer: Peer, packet: Packet) => {
	return peer.send(encodePacket(packet))
}

const linkLog = (link: RoomLink) => {
	return {
		auth: link.auth,
		id: link.id,
		remoteId:
			link.remoteId == null ? null : participantIdToString(link.remoteId),
		role: link.role,
		source: link.source,
	}
}

const warnRoom = (event: string, details: Record<string, unknown> = {}) => {
	warnLog('room', event, details)
}

const infoRoom = (event: string, details: Record<string, unknown> = {}) => {
	infoLog('room', event, details)
}

const errorRoom = (event: string, details: Record<string, unknown> = {}) => {
	errorLog('room', event, details)
}

const MAX_PENDING_TRACKER_LINKS = 2

export const createRoom = () => {
	const incomingFiles = new Map<string, IncomingFileTransfer>()
	let fileUrls = new Set<string>()
	let pendingLocalBlip: string | null = null
	// Host identity is the closest thing we have to room identity, so it also paints the room.
	let localParticipantId: ParticipantId | null = randomParticipantId()
	let hostParticipantId: ParticipantId | null = localParticipantId
	let roomSecret: RoomSecret | null = null
	let roomKeys: RoomKeys | null = null
	let trackerRendezvous: TrackerRendezvous | null = null
	let signalingVersion = 0
	let linkSequence = 0
	let selfMediaVersion = 0
	const trackerOffers = new Map<string, RoomLink>()
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

	const participantByKey = (key: ParticipantKey) => {
		return participants[key] ?? null
	}

	const selfActivity = createMemo(() => {
		const key = localKey()
		return key == null
			? emptyParticipantActivity()
			: (participantByKey(key)?.activity ?? emptyParticipantActivity())
	})

	const isHostRoom = () => {
		return (
			localParticipantId != null && localParticipantId === hostParticipantId
		)
	}

	const isGuestRoom = () => {
		return (
			localParticipantId != null &&
			hostParticipantId != null &&
			localParticipantId !== hostParticipantId
		)
	}

	const touchLinks = () => {
		setLinkRevision((revision) => revision + 1)
	}

	const peerByKey = (key: ParticipantKey): RoomPeer | null => {
		const participant = participantByKey(key)
		if (participant == null) return null

		// links is intentionally a transport map; this signal bridges it into Solid projections.
		linkRevision()
		const link = linkByParticipantKey(key)
		return {
			...participant,
			mediaState: link?.mediaState ?? null,
			mediaStream: link?.mediaStream ?? null,
			state: link?.live ? 'live' : 'waiting',
		}
	}

	const participantById = (participantId: ParticipantId | null) => {
		return participantId == null
			? null
			: participantByKey(participantKey(participantId))
	}

	const nextLinkId = (role: LinkRole): LinkId => {
		linkSequence++
		return `${role}:${linkSequence}`
	}

	const currentRendezvousLink = (role?: LinkRole, source?: LinkSource) => {
		return findRendezvousLink(links.values(), role, source)
	}

	const linkByParticipantKey = (key: ParticipantKey) => {
		return findParticipantLink(links.values(), key)
	}

	const linkedPeers = () => {
		return [...links.values()].map((link) => link.peer)
	}

	const removeLink = (link: RoomLink) => {
		if (links.get(link.id) !== link) return

		link.live = false
		links.delete(link.id)
		for (const [offerId, offerLink] of trackerOffers) {
			if (offerLink === link) trackerOffers.delete(offerId)
		}
		touchLinks()
	}

	const closeLink = (link: RoomLink) => {
		removeLink(link)

		try {
			link.peer.close()
		} catch {}
	}

	const closeRendezvousLink = (role?: LinkRole, source?: LinkSource) => {
		const link = currentRendezvousLink(role, source)
		if (link != null) closeLink(link)
	}

	const closeAllLinks = () => {
		const closingLinks = [...links.values()]
		links.clear()
		trackerOffers.clear()
		for (const link of closingLinks) link.live = false
		touchLinks()

		for (const link of closingLinks) {
			try {
				link.peer.close()
			} catch {}
		}
	}

	const stopTrackerRendezvous = () => {
		trackerRendezvous?.close()
		trackerRendezvous = null
		trackerOffers.clear()
	}

	const participantLink = (participantId: ParticipantId) => {
		return linkByParticipantKey(participantKey(participantId))
	}

	const adoptLink = (link: RoomLink, participantId: ParticipantId) => {
		if (links.get(link.id) !== link) return false
		if (link.remoteId != null && link.remoteId !== participantId) return false

		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return false

		const existing = linkByParticipantKey(key)
		if (existing != null && existing !== link) closeLink(existing)

		link.remoteId = participantId
		for (const [offerId, offerLink] of trackerOffers) {
			if (offerLink === link) trackerOffers.delete(offerId)
		}
		touchLinks()
		return true
	}

	const closeSiblingRendezvousLinks = (link: RoomLink) => {
		for (const candidate of [...links.values()]) {
			if (
				candidate !== link &&
				candidate.remoteId == null &&
				candidate.role === link.role &&
				candidate.source === link.source
			) {
				closeLink(candidate)
			}
		}
	}

	const pendingTrackerLinkCount = (role: LinkRole) => {
		let count = 0

		for (const link of links.values()) {
			if (
				link.auth === 'pending' &&
				link.remoteId == null &&
				link.role === role &&
				link.source === 'tracker'
			) {
				count++
			}
		}

		return count
	}

	const replaceParticipants = (roster: Participant[]) => {
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

	const deleteParticipant = (participantId: ParticipantId) => {
		const key = participantKey(participantId)
		const link = participantLink(participantId)

		if (link != null) removeLink(link)
		setParticipantKeys((keys) => keys.filter((item) => item !== key))
		setParticipants(key, undefined)

		return link
	}

	const allocateParticipantId = () => {
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

	const resetHostParticipants = () => {
		stopTrackerRendezvous()
		pendingLocalBlip = null
		roomSecret = null
		roomKeys = null
		localParticipantId = randomParticipantId()
		hostParticipantId = localParticipantId
		closeAllLinks()

		const host = mergeParticipant({ id: localParticipantId })
		setParticipants(reconcile({ [host.id]: host }))
		setParticipantKeys([host.id])
		setLocalKey(host.id)
		setState('themeSeed', host.id)
	}

	const resetGuestParticipants = (
		options: { keepPendingBlip?: boolean } = {},
	) => {
		stopTrackerRendezvous()
		if (!options.keepPendingBlip) pendingLocalBlip = null
		roomSecret = null
		roomKeys = null
		localParticipantId = null
		hostParticipantId = null
		closeAllLinks()
		setParticipants(reconcile({}))
		setParticipantKeys([])
		setLocalKey(null)
	}

	const roomRoster = () => {
		return participantKeys()
			.map((key) => participants[key])
			.filter((person): person is RoomParticipant => person != null)
			.map(rosterParticipant)
	}

	const liveParticipantLinkCount = () => {
		return liveParticipantLinks().length
	}

	const sendToParticipant = (participantId: ParticipantId, packet: Packet) => {
		const link = participantLink(participantId)
		if (link == null || !link.live) return false

		return sendPacket(link.peer, packet)
	}

	const sendToLinks = (targetLinks: RoomLink[], packet: Packet) => {
		let sent = 0

		for (const link of targetLinks) {
			if (link.live && sendPacket(link.peer, packet)) sent++
		}

		return sent
	}

	const broadcastPacket = (
		packet: Packet,
		except: ParticipantId | null = null,
	) => {
		const exceptKey = except == null ? null : participantKey(except)

		for (const key of participantKeys()) {
			const link = linkByParticipantKey(key)
			if (key === exceptKey || link == null || !link.live) {
				continue
			}

			sendPacket(link.peer, packet)
		}
	}

	const broadcastMembershipChange = (
		options: { left?: ParticipantId } = {},
	) => {
		// Membership is a protocol commit, not any participant-store mutation.
		if (options.left != null) {
			broadcastPacket({ type: 'peer-left', id: options.left })
		}
		broadcastPacket({ type: 'roster', roster: roomRoster() })
	}

	const liveParticipantLinks = () => {
		return liveIdentifiedLinks(links.values())
	}

	const selfMediaState = (
		media: SelfMedia = state.selfMedia,
	): PeerMediaState => {
		return {
			cameraEnabled:
				media.status === 'live' && media.cameraAvailable && media.cameraEnabled,
			microphoneEnabled:
				media.status === 'live' &&
				media.microphoneAvailable &&
				media.microphoneEnabled,
		}
	}

	const setPeerMediaState = (
		participantId: ParticipantId,
		mediaState: PeerMediaState,
	) => {
		const link = participantLink(participantId)
		if (link == null) return

		link.mediaState = mediaState
		touchLinks()
	}

	const setParticipantBlip = (participantId: ParticipantId, text: string) => {
		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return

		const blip = text.trim()
		setParticipants(key, 'activity', 'blip', blip === '' ? null : blip)
	}

	const localBlip = () => {
		return (
			participantById(localParticipantId)?.activity.blip ?? pendingLocalBlip
		)
	}

	const applyPendingLocalBlip = () => {
		if (localParticipantId == null || pendingLocalBlip == null) return

		setParticipantBlip(localParticipantId, pendingLocalBlip)
		pendingLocalBlip = null
	}

	const sendLocalBlipToPeer = (peer: Peer) => {
		const blip = localBlip()
		if (blip == null) return false

		return sendPacket(peer, { type: 'blip', text: blip })
	}

	const sendLocalMediaStateToPeer = (
		peer: Peer,
		mediaState = selfMediaState(),
	) => {
		return sendPacket(peer, { ...mediaState, type: 'media-state' })
	}

	const verifyLink = (link: RoomLink) => {
		link.auth = 'verified'
		link.authNonce = null
		touchLinks()
	}

	const sendTrackerChallenge = (link: RoomLink) => {
		if (roomKeys == null) {
			errorRoom('auth.challenge.missing-room-keys', { link: linkLog(link) })
			closeLink(link)
			return
		}

		const nonce = randomNonce()
		link.authNonce = nonce
		if (!sendPacket(link.peer, { nonce, type: 'auth-challenge' })) {
			warnRoom('auth.challenge.send.failed', { link: linkLog(link) })
			closeLink(link)
			return
		}
		infoRoom('auth.challenge.sent', { link: linkLog(link) })
	}

	const answerTrackerChallenge = async (link: RoomLink, nonce: string) => {
		if (roomKeys == null) {
			errorRoom('auth.response.missing-room-keys', { link: linkLog(link) })
			closeLink(link)
			return
		}

		let mac: string
		try {
			mac = await signRoomAuth(roomKeys.authKey, nonce)
		} catch (error) {
			warnRoom('auth.response.sign.failed', { error, link: linkLog(link) })
			closeLink(link)
			return
		}
		if (links.get(link.id) !== link) return

		if (!sendPacket(link.peer, { mac, type: 'auth-response' })) {
			warnRoom('auth.response.send.failed', { link: linkLog(link) })
			closeLink(link)
			return
		}
		infoRoom('auth.response.sent', { link: linkLog(link) })
	}

	const acceptTrackerResponse = async (link: RoomLink, mac: string) => {
		if (roomKeys == null) {
			errorRoom('auth.accept.missing-room-keys', { link: linkLog(link) })
			closeLink(link)
			return
		}

		if (link.authNonce == null) {
			warnRoom('auth.accept.missing-nonce', { link: linkLog(link) })
			closeLink(link)
			return
		}

		let verified: boolean
		try {
			verified = await verifyRoomAuth(roomKeys.authKey, link.authNonce, mac)
		} catch (error) {
			warnRoom('auth.accept.verify.failed', { error, link: linkLog(link) })
			closeLink(link)
			return
		}
		if (links.get(link.id) !== link) return

		if (!verified) {
			warnRoom('auth.accept.rejected', { link: linkLog(link) })
			closeLink(link)
			return
		}

		verifyLink(link)
		if (!sendPacket(link.peer, { type: 'auth-accepted' })) {
			warnRoom('auth.accept.send.failed', { link: linkLog(link) })
			closeLink(link)
			return
		}
		infoRoom('auth.accept.sent', { link: linkLog(link) })
	}

	const handleAuthPacket = (link: RoomLink, message: Packet) => {
		switch (message.type) {
			case 'auth-challenge':
				if (link.source !== 'tracker' || link.role !== 'guest-rendezvous') {
					warnRoom('auth.challenge.unexpected', { link: linkLog(link) })
					return true
				}

				void answerTrackerChallenge(link, message.nonce)
				return true
			case 'auth-accepted':
				if (link.source !== 'tracker' || link.role !== 'guest-rendezvous') {
					warnRoom('auth.accepted.unexpected', { link: linkLog(link) })
					return true
				}

				verifyLink(link)
				if (!sendPacket(link.peer, { type: 'hello' })) {
					warnRoom('auth.hello.send.failed', { link: linkLog(link) })
					closeLink(link)
					return true
				}
				infoRoom('auth.hello.sent', { link: linkLog(link) })
				return true
			case 'auth-response':
				if (link.source !== 'tracker' || link.role !== 'host-rendezvous') {
					warnRoom('auth.response.unexpected', { link: linkLog(link) })
					return true
				}

				void acceptTrackerResponse(link, message.mac)
				return true
			default:
				return false
		}
	}

	const publishLocalBlip = () => {
		const blip = localBlip()
		if (blip == null) return 0

		return sendToLinks(liveParticipantLinks(), { type: 'blip', text: blip })
	}

	const publishLocalMediaState = (mediaState = selfMediaState()) => {
		return sendToLinks(liveParticipantLinks(), {
			...mediaState,
			type: 'media-state',
		})
	}

	const setBlipIssue = (issue: string | null) => {
		setState('blipComposer', 'issue', issue)
	}

	const upsertParticipantFile = (
		participantId: ParticipantId,
		file: FileProgress,
	) => {
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

	const markLocalSendingFilesError = () => {
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

	const disposeFileUrls = () => {
		for (const url of fileUrls) {
			URL.revokeObjectURL(url)
		}

		fileUrls = new Set()
	}

	const handlePeerBlip = (participantId: ParticipantId, text: string) => {
		setParticipantBlip(participantId, text)
	}

	const handleFileStart = (
		participantId: ParticipantId,
		message: Extract<Packet, { type: 'file-start' }>,
	) => {
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

	const handleFileChunk = (
		message: Extract<Packet, { type: 'file-chunk' }>,
	) => {
		const transfer = incomingFiles.get(message.id)
		if (transfer == null) return

		let bytes: Uint8Array
		try {
			bytes = base64ToBytes(message.data)
		} catch (error) {
			warnRoom('file.chunk.decode.failed', { error, id: message.id })
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

	const handleFileEnd = (message: Extract<Packet, { type: 'file-end' }>) => {
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

	const handleCommonMessage = (
		participantId: ParticipantId,
		message: Packet,
	) => {
		// Blips and files are symmetric; only connection setup needs host/guest ceremony.
		switch (message.type) {
			case 'blip':
				handlePeerBlip(participantId, message.text)
				return true
			case 'media-state':
				setPeerMediaState(participantId, {
					cameraEnabled: message.cameraEnabled,
					microphoneEnabled: message.microphoneEnabled,
				})
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

	const clearPeerParticipants = () => {
		const local = localKey()
		const self = local == null ? null : participants[local]

		setParticipants(
			reconcile(local != null && self != null ? { [local]: self } : {}),
		)
		setParticipantKeys(local == null ? [] : [local])
	}

	const markRoomClosed = () => {
		stopTrackerRendezvous()
		closeAllLinks()
		clearPeerParticipants()
		setState('connection', closedConnection())
	}

	const removeParticipantLink = (
		participantId: ParticipantId,
		options: { peer?: Peer | null } = {},
	) => {
		const key = participantKey(participantId)
		const link = participantLink(participantId)
		if (link == null) return
		if (options.peer != null && link.peer !== options.peer) return

		removeLink(link)

		if (isGuestRoom() && participantId === hostParticipantId) {
			markRoomClosed()
			return
		}

		// Guests can come and go. A guest only loses the room when the host disappears.
		if (isHostRoom()) {
			setParticipantKeys((keys) => keys.filter((item) => item !== key))
			setParticipants(key, undefined)
			broadcastMembershipChange({ left: participantId })

			if (
				liveParticipantLinkCount() === 0 &&
				currentRendezvousLink('host-rendezvous', 'manual') == null
			) {
				void startHostInvite({ resetPeers: false })
			}
		}
	}

	const assignGuestParticipant = (): Participant => {
		return { id: allocateParticipantId() }
	}

	const createLink = (
		role: LinkRole,
		options: {
			auth?: LinkAuthState
			remoteId?: ParticipantId | null
			source?: LinkSource
		} = {},
	) => {
		const source = options.source ?? 'manual'
		const id = nextLinkId(role)
		const peer = createPeer({
			onOpen: () => handleLinkOpen(id),
			onMessage: (text) => handleLinkMessage(id, text),
			onRemoteMedia: (stream) => {
				const link = links.get(id)
				if (link == null) return

				link.mediaStream = stream
				touchLinks()
			},
			onState: (state) => {
				const link = links.get(id)
				if (link == null || link.source !== 'tracker') return

				infoRoom('rtc.state', { link: linkLog(link), ...state })
			},
			onClose: () => handleLinkClose(id),
		})

		const link: RoomLink = {
			auth: options.auth ?? (source === 'tracker' ? 'pending' : 'verified'),
			authNonce: null,
			id,
			live: false,
			mediaState: null,
			mediaStream: null,
			peer,
			remoteId: options.remoteId ?? null,
			role,
			source,
		}
		links.set(id, link)
		touchLinks()
		peer.setLocalMedia(state.selfMedia.stream)
		return link
	}

	const handleLinkOpen = (linkId: LinkId) => {
		const link = links.get(linkId)
		if (link == null) return

		link.live = true
		touchLinks()
		infoRoom('link.open', { link: linkLog(link) })

		if (link.source === 'tracker' && link.auth !== 'verified') {
			if (link.role === 'host-rendezvous') sendTrackerChallenge(link)
			else if (link.role !== 'guest-rendezvous') {
				errorRoom('auth.unexpected-tracker-link-role', { link: linkLog(link) })
				closeLink(link)
			}
			return
		}

		if (link.role === 'guest-rendezvous') {
			sendPacket(link.peer, { type: 'hello' })
			return
		}

		if (link.remoteId != null) {
			sendLocalBlipToPeer(link.peer)
			sendLocalMediaStateToPeer(link.peer)
		}
	}

	const handleLinkClose = (linkId: LinkId) => {
		const link = links.get(linkId)
		if (link == null) return

		infoRoom('link.close', { link: linkLog(link) })
		if (link.remoteId != null) {
			removeParticipantLink(link.remoteId, { peer: link.peer })
			return
		}

		removeLink(link)
		if (
			link.role === 'host-rendezvous' &&
			link.source === 'manual' &&
			isHostRoom()
		) {
			void startHostInvite({ resetPeers: false })
		} else if (
			link.role === 'guest-rendezvous' &&
			link.source === 'tracker' &&
			localParticipantId == null
		) {
			return
		} else if (link.role === 'guest-rendezvous') {
			markRoomClosed()
		}
	}

	const handleLinkMessage = (linkId: LinkId, text: string) => {
		const link = links.get(linkId)
		if (link == null) return

		const message = decodePacket(text)
		if (message == null) {
			warnRoom('packet.decode.failed', { length: text.length, linkId })
			return
		}
		if (handleAuthPacket(link, message)) return
		if (link.source === 'tracker' && link.auth !== 'verified') {
			// Tracker-discovered transports are only candidates until they prove the room secret.
			warnRoom('packet.before-auth', {
				link: linkLog(link),
				type: message.type,
			})
			return
		}

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

	const handlePeerMessage = (link: RoomLink, message: Packet) => {
		if (link.remoteId == null) {
			warnRoom('mesh.message.missing-remote', {
				link: linkLog(link),
				type: message.type,
			})
			return
		}

		handleCommonMessage(link.remoteId, message)
	}

	const createMeshLink = (participantId: ParticipantId) => {
		const link = createLink('mesh', { remoteId: participantId })

		if (participantById(participantId) == null) {
			warnRoom('mesh.link.unknown-participant', {
				participantId: participantIdToString(participantId),
			})
			closeLink(link)
			return null
		}

		return link
	}

	const sendToHost = (message: Packet) => {
		if (hostParticipantId == null) return false
		return sendToParticipant(hostParticipantId, message)
	}

	const createMeshOffer = async (participantId: ParticipantId) => {
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
			if (participantLink(participantId) !== link) {
				closeLink(link)
				return
			}

			if (
				!sendToHost({
					type: 'peer-offer',
					from: localParticipantId,
					to: participantId,
					signal,
				})
			) {
				warnRoom('mesh.offer.send.failed', {
					participantId: participantIdToString(participantId),
				})
				closeLink(link)
			}
		} catch (error) {
			warnRoom('mesh.offer.failed', {
				error,
				participantId: participantIdToString(participantId),
			})
			closeLink(link)
		}
	}

	const startMissingMeshOffers = () => {
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

	const acceptMeshOffer = async (
		message: Extract<Packet, { type: 'peer-offer' }>,
	) => {
		if (!isGuestRoom() || localParticipantId == null) {
			return
		}
		if (message.to !== localParticipantId) {
			warnRoom('mesh.offer.wrong-target', {
				from: participantIdToString(message.from),
				to: participantIdToString(message.to),
			})
			return
		}

		const existing = participantLink(message.from)
		if (existing != null) closeLink(existing)

		const link = createMeshLink(message.from)
		if (link == null) return

		try {
			const signal = await link.peer.createAnswer(message.signal)
			if (participantLink(message.from) !== link) {
				closeLink(link)
				return
			}

			if (
				!sendToHost({
					type: 'peer-answer',
					from: localParticipantId,
					to: message.from,
					signal,
				})
			) {
				warnRoom('mesh.answer.send.failed', {
					participantId: participantIdToString(message.from),
				})
				closeLink(link)
			}
		} catch (error) {
			warnRoom('mesh.answer.failed', {
				error,
				participantId: participantIdToString(message.from),
			})
			closeLink(link)
		}
	}

	const acceptMeshAnswer = async (
		message: Extract<Packet, { type: 'peer-answer' }>,
	) => {
		if (localParticipantId == null) return
		if (message.to !== localParticipantId) {
			warnRoom('mesh.answer.wrong-target', {
				from: participantIdToString(message.from),
				to: participantIdToString(message.to),
			})
			return
		}

		const link = participantLink(message.from)
		if (link == null) {
			warnRoom('mesh.answer.missing-link', {
				from: participantIdToString(message.from),
			})
			return
		}

		try {
			await link.peer.acceptAnswer(message.signal)
		} catch (error) {
			warnRoom('mesh.answer.accept.failed', {
				error,
				from: participantIdToString(message.from),
			})
			closeLink(link)
		}
	}

	const applyRoster = (roster: Participant[]) => {
		if (
			hostParticipantId != null &&
			!roster.some((p) => p.id === hostParticipantId)
		) {
			warnRoom('roster.missing-host', {
				hostId: participantIdToString(hostParticipantId),
			})
			markRoomClosed()
			return
		}

		replaceParticipants(roster)
		startMissingMeshOffers()
	}

	const removeRosterParticipant = (participantId: ParticipantId) => {
		if (participantId === hostParticipantId) {
			markRoomClosed()
			return
		}

		deleteParticipant(participantId)?.peer.close()
	}

	const handleGuestMessage = (link: RoomLink, message: Packet) => {
		const senderId = hostParticipantId ?? link.remoteId
		if (senderId != null && handleCommonMessage(senderId, message)) return

		switch (message.type) {
			case 'welcome':
				// Welcome is the handoff from paste-code UX into actual room membership.
				localParticipantId = message.selfId
				hostParticipantId = message.hostId
				stopTrackerRendezvous()
				clearInviteHash()
				setState('themeSeed', participantIdToString(message.hostId))
				setLocalKey(participantKey(message.selfId))
				replaceParticipants(message.roster)
				applyPendingLocalBlip()
				if (!adoptLink(link, message.hostId)) {
					errorRoom('guest.welcome.adopt-link.failed', {
						hostId: participantIdToString(message.hostId),
						link: linkLog(link),
					})
					markRoomClosed()
					return
				}
				closeSiblingRendezvousLinks(link)
				setState('connection', {
					...(state.connection.side === 'guest'
						? state.connection
						: emptyGuestConnection()),
					status: 'connected',
					issue: null,
				})
				publishLocalBlip()
				publishLocalMediaState()
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
			case 'media-state':
				break
		}
	}

	const sendHostWelcome = (participantId: ParticipantId) => {
		if (localParticipantId == null) {
			errorRoom('welcome.missing-local-host-id', {
				participantId: participantIdToString(participantId),
			})
			return
		}
		const sent = sendToParticipant(participantId, {
			type: 'welcome',
			hostId: localParticipantId,
			selfId: participantId,
			roster: roomRoster(),
		})
		if (!sent) {
			warnRoom('welcome.send.failed', {
				participantId: participantIdToString(participantId),
			})
			const link = participantLink(participantId)
			if (link != null) closeLink(link)
			return
		}
		const link = participantLink(participantId)
		if (link != null) {
			sendLocalBlipToPeer(link.peer)
			sendLocalMediaStateToPeer(link.peer)
		}
	}

	const handleHostPacket = (participantId: ParticipantId, message: Packet) => {
		if (handleCommonMessage(participantId, message)) return
		switch (message.type) {
			case 'hello':
				sendHostWelcome(participantId)
				broadcastMembershipChange()
				break
			case 'peer-offer':
			case 'peer-answer':
				// The host introduces guests; it should not become the long-term transport.
				if (message.to === localParticipantId) {
					warnRoom('mesh.signal.addressed-to-host', {
						from: participantIdToString(participantId),
						type: message.type,
					})
					return
				}
				if (
					!sendToParticipant(message.to, { ...message, from: participantId })
				) {
					warnRoom('mesh.signal.forward.failed', {
						from: participantIdToString(participantId),
						to: participantIdToString(message.to),
						type: message.type,
					})
				}
				break
			case 'peer-left':
			case 'file-chunk':
			case 'file-end':
			case 'file-start':
			case 'roster':
			case 'blip':
			case 'media-state':
			case 'welcome':
				break
		}
	}

	const admitHostRendezvous = (link: RoomLink) => {
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
			errorRoom('host.admit.adopt-link.failed', {
				link: linkLog(link),
				participantId: participantIdToString(participant.id),
			})
			deleteParticipant(participant.id)
			return null
		}
		closeSiblingRendezvousLinks(link)

		if (state.connection.side === 'host') {
			setState('connection', {
				...state.connection,
				issue: null,
				replyText: '',
			})
		}
		infoRoom('host.admit', {
			link: linkLog(link),
			participantId: participantIdToString(participant.id),
		})
		return { fresh: true, participantId: participant.id }
	}

	const handleHostRendezvousMessage = (link: RoomLink, message: Packet) => {
		let participantId = link.remoteId
		let fresh = false
		if (participantId == null && message.type === 'hello') {
			const admission = admitHostRendezvous(link)
			if (admission == null) return

			participantId = admission.participantId
			fresh = admission.fresh
		}

		if (participantId == null) {
			warnRoom('host.rendezvous.message-before-hello', {
				link: linkLog(link),
				type: message.type,
			})
			return
		}

		handleHostPacket(participantId, message)
		if (fresh) {
			// Keep the host ready for the next person only after this peer joined the room protocol.
			void startHostInvite({ resetPeers: false })
		}
	}

	const setHostAutoStatus = (status: TrackerStatus) => {
		if (state.connection.side !== 'host') return

		setState('connection', {
			...state.connection,
			autoStatus: status,
		})
	}

	const trackerRendezvousRole = (): LinkRole | null => {
		if (isHostRoom()) return 'host-rendezvous'
		if (isGuestRoomLike()) return 'guest-rendezvous'

		return null
	}

	const createTrackerOffer = async (offerId: string) => {
		const role = trackerRendezvousRole()
		if (role == null) return null

		const link = createLink(role, { source: 'tracker' })
		trackerOffers.set(offerId, link)

		setTimeout(() => {
			if (trackerOffers.get(offerId) !== link || link.remoteId != null) return

			closeLink(link)
		}, 45_000)

		try {
			const offer = await link.peer.createOffer()
			if (trackerOffers.get(offerId) !== link) {
				closeLink(link)
				return null
			}

			return offer
		} catch (error) {
			warnRoom('tracker.offer.create.failed', {
				error,
				link: linkLog(link),
				offerId,
			})
			closeLink(link)
			return null
		}
	}

	const acceptTrackerAnswer = (offerId: string, answer: SignalDescription) => {
		const link = trackerOffers.get(offerId)
		if (link == null) {
			warnRoom('tracker.answer.missing-offer', { offerId })
			return
		}

		infoRoom('tracker.answer.accept.start', { link: linkLog(link) })
		void link.peer
			.acceptAnswer(answer)
			.then(() => {
				if (links.get(link.id) !== link) return

				infoRoom('tracker.answer.accept.done', { link: linkLog(link) })
			})
			.catch((error) => {
				warnRoom('tracker.answer.accept.failed', {
					error,
					link: linkLog(link),
					offerId,
				})
				closeLink(link)
			})
	}

	const answerTrackerOffer = (
		offer: SignalDescription,
		reply: (answer: SignalDescription) => void,
	) => {
		const role = trackerRendezvousRole()
		if (roomKeys == null || role == null) {
			warnRoom('tracker.offer.unexpected', {
				hasRoomKeys: roomKeys != null,
				role,
			})
			return
		}
		if (pendingTrackerLinkCount(role) >= MAX_PENDING_TRACKER_LINKS) {
			infoRoom('tracker.offer.ignored.pending-capacity', {
				pending: pendingTrackerLinkCount(role),
				role,
			})
			return
		}

		const link = createLink(role, { source: 'tracker' })
		setTimeout(() => {
			if (links.get(link.id) !== link || link.remoteId != null) return

			closeLink(link)
		}, 45_000)

		void link.peer
			.createAnswer(offer)
			.then((answer) => {
				if (links.get(link.id) !== link) return

				infoRoom('tracker.offer.answer.sent', { link: linkLog(link) })
				reply(answer)
			})
			.catch((error) => {
				warnRoom('tracker.offer.answer.failed', {
					error,
					link: linkLog(link),
				})
				closeLink(link)
			})
	}

	const isGuestRoomLike = () => {
		return localParticipantId == null || isGuestRoom()
	}

	const startTrackerRendezvous = async (
		secret: RoomSecret,
		role: 'guest' | 'host',
		version: number,
	) => {
		try {
			const keys = await deriveRoomKeys(secret)
			if (version !== signalingVersion || roomSecret !== secret) return

			roomKeys = keys
			trackerRendezvous?.close()
			if (role === 'host') {
				for (const link of new Set(trackerOffers.values())) closeLink(link)
				trackerOffers.clear()
			}
			trackerRendezvous = createTrackerRendezvous({
				createOffer: createTrackerOffer,
				infoHash: keys.infoHash,
				onAnswer: acceptTrackerAnswer,
				onOffer: answerTrackerOffer,
				onStatus: (status) => {
					if (version !== signalingVersion || roomSecret !== secret) return

					if (role === 'host') {
						setHostAutoStatus(status === 'idle' ? 'finding' : status)
					} else if (
						status === 'failed' &&
						state.connection.side === 'guest' &&
						state.connection.status === 'finding-link'
					) {
						setState('connection', {
							...state.connection,
							issue:
								'Automatic link did not find the host yet. Ask for the invite code if it keeps waiting.',
						})
					}
				},
				role,
			})
		} catch (error) {
			warnRoom('tracker.start.failed', { error, role })
			if (role === 'host') setHostAutoStatus('failed')
			else if (state.connection.side === 'guest') {
				setState('connection', {
					...state.connection,
					issue:
						'Automatic link could not start here. Ask for the invite code instead.',
				})
			}
		}
	}

	const joinAutoRoom = (secret: RoomSecret) => {
		const version = ++signalingVersion
		resetGuestParticipants({ keepPendingBlip: true })
		roomSecret = secret
		setState('connection', {
			...emptyGuestConnection(),
			status: 'finding-link',
			inviteText: autoInviteLinkFromSecret(secret),
		})
		void startTrackerRendezvous(secret, 'guest', version)
	}

	const startHostInvite = async (
		options: { resetPeers: boolean } = { resetPeers: true },
	) => {
		const version = ++signalingVersion
		let nextLink: RoomLink | null = null

		try {
			if (options.resetPeers) {
				resetHostParticipants()
				clearInviteHash()
				setState('blipComposer', emptyBlipComposer())
			} else if (localParticipantId == null || hostParticipantId == null) {
				resetHostParticipants()
			} else {
				closeRendezvousLink('host-rendezvous', 'manual')
			}

			if (roomSecret == null) roomSecret = randomRoomSecret()
			const secret = roomSecret
			const autoInviteLink = autoInviteLinkFromSecret(secret)
			setState('connection', {
				...emptyHostConnection(),
				autoInviteLink,
				autoStatus: 'finding',
			})
			void startTrackerRendezvous(secret, 'host', version)

			nextLink = createLink('host-rendezvous', { source: 'manual' })
			const offer = await nextLink.peer.createOffer()
			const inviteCode = await encodeSignal(offer)
			if (
				version !== signalingVersion ||
				currentRendezvousLink('host-rendezvous', 'manual') !== nextLink
			) {
				closeLink(nextLink)
				return
			}

			const manualInviteLink = manualInviteLinkFromCode(inviteCode)
			setState('connection', {
				...emptyHostConnection(),
				autoInviteLink,
				autoStatus:
					state.connection.side === 'host'
						? state.connection.autoStatus
						: 'finding',
				status: 'invite-ready',
				manualInviteLink,
			})
		} catch (error) {
			warnRoom('invite.create.failed', { error })
			if (nextLink != null) closeLink(nextLink)
			if (version !== signalingVersion) return
			setState('connection', {
				...(state.connection.side === 'host'
					? state.connection
					: emptyHostConnection()),
				issue: 'Could not create an invite.',
			})
		}
	}

	const becomeGuest = () => {
		signalingVersion++
		clearInviteHash()
		resetGuestParticipants()
		setState('connection', emptyGuestConnection())
		setState('blipComposer', emptyBlipComposer())
	}

	const createReply = async (inviteText?: string) => {
		const inviteInput = (
			inviteText ??
			(state.connection.side === 'guest' ? state.connection.inviteText : '')
		).trim()
		const invite = inviteFromInput(inviteInput)
		if (invite.type === 'empty') return
		if (invite.type === 'auto-link') {
			joinAutoRoom(invite.secret)
			return
		}

		const version = ++signalingVersion
		let nextLink: RoomLink | null = null

		try {
			resetGuestParticipants({ keepPendingBlip: true })
			setState('connection', {
				...emptyGuestConnection(),
				status: 'creating-reply',
				inviteText: inviteInput,
			})

			nextLink = createLink('guest-rendezvous', { source: 'manual' })
			const offer = await decodeSignal(invite.code)
			const answer = await nextLink.peer.createAnswer(offer)
			const replyCode = await encodeSignal(answer)
			if (
				version !== signalingVersion ||
				currentRendezvousLink('guest-rendezvous', 'manual') !== nextLink
			) {
				closeLink(nextLink)
				return
			}

			setState('connection', {
				...emptyGuestConnection(),
				status: 'reply-ready',
				inviteText: inviteInput,
				replyCode,
			})
		} catch (error) {
			warnRoom('reply.create.failed', { error })
			if (nextLink != null) closeLink(nextLink)
			if (version !== signalingVersion) return
			closeAllLinks()
			setState('connection', {
				...emptyGuestConnection(),
				inviteText: inviteInput,
				issue: 'That invite did not work. Paste a fresh invite and try again.',
			})
		}
	}

	const acceptReply = async (replyText?: string) => {
		const replyCode = (
			replyText ??
			(state.connection.side === 'host' ? state.connection.replyText : '')
		).trim()
		const answeringLink = currentRendezvousLink('host-rendezvous', 'manual')
		if (replyCode === '' || answeringLink == null) return

		const version = signalingVersion

		try {
			if (state.connection.side === 'host') {
				setState('connection', {
					...state.connection,
					replyText: replyCode,
					status: 'accepting-reply',
					issue: null,
				})
			}

			const answer = await decodeSignal(replyCode)
			await answeringLink.peer.acceptAnswer(answer)
			if (version !== signalingVersion) return
		} catch (error) {
			warnRoom('reply.accept.failed', { error })
			if (version !== signalingVersion) return
			if (state.connection.side === 'host') {
				setState('connection', {
					...state.connection,
					status: 'invite-ready',
					issue:
						'That reply did not work. Ask for a fresh reply or regenerate the invite.',
				})
			}
		}
	}

	const sendBlip = (text = state.blipComposer.text) => {
		const blip = text.trim()
		const currentBlip = localBlip()
		if (blip === '' && currentBlip == null) return

		if (localParticipantId == null) {
			pendingLocalBlip = blip === '' ? null : blip
		} else {
			pendingLocalBlip = null
			setParticipantBlip(localParticipantId, blip)
		}

		sendToLinks(liveParticipantLinks(), {
			type: 'blip',
			text: blip,
		})
		setState('blipComposer', 'text', blip)
		setBlipIssue(null)
	}

	const publishSelfMedia = (stream: MediaStream | null) => {
		const peers = linkedPeers()

		for (const peer of peers) {
			peer.setLocalMedia(stream)
		}
	}

	const sendFileToPeers = async (file: File, peers: RoomLink[]) => {
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

	const sendFiles = async (files: File[]) => {
		if (files.length === 0) return

		const peers = liveParticipantLinks()
		if (peers.length === 0) {
			setBlipIssue('Connect another device before sending files.')
			return
		}

		try {
			for (const file of files) {
				await sendFileToPeers(file, peers)
			}
		} catch (error) {
			warnRoom('file.send.failed', { error })
			markLocalSendingFilesError()
			setBlipIssue('File transfer stopped before it finished.')
		}
	}

	const disposeSelfMedia = () => {
		selfMediaVersion++
		publishSelfMedia(null)
		stopSelfMedia(state.selfMedia)
		const selfMedia = emptySelfMedia()
		setState('selfMedia', selfMedia)
		publishLocalMediaState(selfMediaState(selfMedia))
	}

	const enableSelfMedia = async () => {
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
		publishLocalMediaState(selfMediaState(selfMedia))
	}

	const setTracksEnabled = (kind: 'audio' | 'video', enabled: boolean) => {
		if (!setSelfMediaTracksEnabled(state.selfMedia, kind, enabled)) return

		const selfMedia = {
			...state.selfMedia,
			[kind === 'video' ? 'cameraEnabled' : 'microphoneEnabled']: enabled,
		}
		if (kind === 'video') setState('selfMedia', 'cameraEnabled', enabled)
		else setState('selfMedia', 'microphoneEnabled', enabled)
		publishLocalMediaState(selfMediaState(selfMedia))
	}

	const toggleCamera = () => {
		if (!state.selfMedia.cameraAvailable) return
		setTracksEnabled('video', !state.selfMedia.cameraEnabled)
	}

	const toggleMicrophone = () => {
		if (!state.selfMedia.microphoneAvailable) return
		setTracksEnabled('audio', !state.selfMedia.microphoneEnabled)
	}

	onMount(() => {
		const invite = readInviteFromHash()

		if (invite.type === 'auto-link') {
			joinAutoRoom(invite.secret)
			return
		}

		if (invite.type === 'manual-code') {
			void createReply(invite.code)
			return
		}

		void startHostInvite()
	})

	onCleanup(() => {
		stopTrackerRendezvous()
		closeAllLinks()
		disposeFileUrls()
		disposeSelfMedia()
	})

	const actions = {
		becomeGuest,
		becomeHost: () => {
			void startHostInvite()
		},
		copyAutoInviteLink: () =>
			void copyText(
				state.connection.side === 'host' ? state.connection.autoInviteLink : '',
			),
		copyManualInviteLink: () =>
			void copyText(
				state.connection.side === 'host'
					? state.connection.manualInviteLink
					: '',
			),
		copyReplyCode: () =>
			void copyText(
				state.connection.side === 'guest' ? state.connection.replyCode : '',
			),
		createReply: (inviteText?: string) => void createReply(inviteText),
		enableSelfMedia: () => void enableSelfMedia(),
		acceptReply: (replyText?: string) => void acceptReply(replyText),
		sendFiles: (files: File[]) => void sendFiles(files),
		sendBlip: (text?: string) => sendBlip(text),
		setInviteText: (inviteText: string) => {
			if (state.connection.side !== 'guest') return
			setState('connection', {
				...state.connection,
				inviteText,
				issue: null,
			})
		},
		setReplyText: (replyText: string) => {
			if (state.connection.side !== 'host') return
			setState('connection', {
				...state.connection,
				replyText,
				issue: null,
			})
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
