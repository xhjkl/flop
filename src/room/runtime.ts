import { type Accessor, createMemo, createSignal, type Setter } from 'solid-js'
import {
	createStore,
	reconcile,
	type SetStoreFunction,
	type Store,
} from 'solid-js/store'
import {
	type Packet,
	type Participant,
	type ParticipantId,
	participantIdToString,
} from '../protocol'
import type { BeaconRendezvous } from '../rendezvous/beacon'
import type { RoomKeys } from '../rendezvous/crypto'
import type { RoomSecret } from '../rendezvous/secret'
import type {
	PeerMediaState,
	PortraitActivityState,
	PortraitFileState,
} from '../state'
import { createPeer, type Peer } from '../webrtc'
import { type BeaconAuth, createBeaconAuth } from './auth'
import { createRoomBlips, type RoomBlips } from './blip'
import { createRoomFileTransfers, type RoomFileTransfers } from './files'
import { emptyRoomState, type RoomState } from './initial-state'
import {
	findParticipantLink,
	findRendezvousLink,
	type LinkAuthState,
	type LinkId,
	type LinkRole,
	type LinkSource,
	liveIdentifiedLinks,
	type RoomLink,
} from './link'
import { infoRoom, linkLog, sendPacket, warnRoom } from './log'
import {
	createRoomMediaController,
	type RoomMediaController,
	selfMediaState,
} from './media'
import { createRoomMesh, type RoomMesh } from './mesh'
import {
	emptyParticipantActivity,
	mergeParticipant,
	type ParticipantKey,
	participantKey,
	type RoomParticipant,
	randomParticipantId,
	rosterParticipant,
} from './participant'
import type { RoomPeer } from './types'

type ParticipantsStore = Partial<Record<ParticipantKey, RoomParticipant>>

/** Link callbacks supplied by the protocol flow boundary. */
export type RoomLinkEvents = {
	onClose: (linkId: LinkId) => void
	onMessage: (linkId: LinkId, text: string) => void
	onOpen: (linkId: LinkId) => void
}

/** Shared mutable room ledgers plus low-level transport and roster operations. */
export type RoomRuntime = {
	adoptLink: (link: RoomLink, participantId: ParticipantId) => boolean
	allocateParticipantId: () => ParticipantId
	assignGuestParticipant: () => Participant
	beaconAuth: BeaconAuth
	beaconOffers: Map<string, RoomLink>
	beaconRendezvous: BeaconRendezvous | null
	blips: RoomBlips
	broadcastMembershipChange: (options?: { left?: ParticipantId }) => void
	broadcastPacket: (packet: Packet, except?: ParticipantId | null) => void
	closeAllLinks: () => void
	closeLink: (link: RoomLink) => void
	closeRendezvousLink: (role?: LinkRole, source?: LinkSource) => void
	closeSiblingRendezvousLinks: (link: RoomLink) => void
	createLink: (
		role: LinkRole,
		options?: {
			auth?: LinkAuthState
			beaconPeerId?: string | null
			remoteId?: ParticipantId | null
			source?: LinkSource
		},
	) => RoomLink
	createMeshLink: (participantId: ParticipantId) => RoomLink | null
	currentRendezvousLink: (
		role?: LinkRole,
		source?: LinkSource,
	) => RoomLink | null
	deleteParticipant: (participantId: ParticipantId) => RoomLink | null
	fileTransfers: RoomFileTransfers
	handleCommonMessage: (
		participantId: ParticipantId,
		message: Packet,
	) => boolean
	hostParticipantId: ParticipantId | null
	isSelfGuest: () => boolean
	isSelfHost: () => boolean
	linkByParticipantKey: (key: ParticipantKey) => RoomLink | null
	linkSequence: number
	links: Map<LinkId, RoomLink>
	linkedPeers: () => Peer[]
	liveParticipantLinkCount: () => number
	liveParticipantLinks: () => RoomLink[]
	localKey: Accessor<ParticipantKey | null>
	localParticipantId: ParticipantId | null
	markLocalSendingFilesError: () => void
	media: RoomMediaController
	mesh: RoomMesh
	participantById: (
		participantId: ParticipantId | null,
	) => RoomParticipant | null
	participantByKey: (key: ParticipantKey) => RoomParticipant | null
	participantKeys: Accessor<ParticipantKey[]>
	participantLink: (participantId: ParticipantId) => RoomLink | null
	participants: Store<ParticipantsStore>
	peers: Accessor<RoomPeer[]>
	publishLocalMediaState: (mediaState?: PeerMediaState) => number
	removeLink: (link: RoomLink) => void
	replaceParticipants: (roster: Participant[]) => void
	roomKeys: RoomKeys | null
	roomRoster: () => Participant[]
	roomSecret: RoomSecret | null
	selfActivity: Accessor<PortraitActivityState>
	sendLocalMediaStateToPeer: (
		peer: Peer,
		mediaState?: PeerMediaState,
	) => boolean
	sendToHost: (message: Packet) => boolean
	sendToLinks: (targetLinks: RoomLink[], packet: Packet) => number
	sendToParticipant: (participantId: ParticipantId, packet: Packet) => boolean
	setBlipIssue: (issue: string | null) => void
	setLocalKey: Setter<ParticipantKey | null>
	setParticipantBlip: (participantId: ParticipantId, text: string) => void
	setParticipantKeys: Setter<ParticipantKey[]>
	setParticipants: SetStoreFunction<ParticipantsStore>
	setPeerMediaState: (
		participantId: ParticipantId,
		mediaState: PeerMediaState,
	) => void
	setState: SetStoreFunction<RoomState>
	signalingVersion: number
	state: Store<RoomState>
	stopBeaconRendezvous: () => void
	touchLinks: () => void
	upsertParticipantFile: (
		participantId: ParticipantId,
		nextFile: PortraitFileState,
	) => void
	verifyLink: (link: RoomLink) => void
}

type RoomRuntimeSeed = Pick<
	RoomRuntime,
	| 'beaconOffers'
	| 'beaconRendezvous'
	| 'hostParticipantId'
	| 'linkSequence'
	| 'links'
	| 'localKey'
	| 'localParticipantId'
	| 'participantKeys'
	| 'participants'
	| 'roomKeys'
	| 'roomSecret'
	| 'setLocalKey'
	| 'setParticipantKeys'
	| 'setParticipants'
	| 'setState'
	| 'signalingVersion'
	| 'state'
>

/** Create the long-lived room runtime without choosing a host or guest flow. */
export const createRoomRuntime = (runtimeOptions: {
	linkEvents: RoomLinkEvents
}): RoomRuntime => {
	const hostParticipant = mergeParticipant({ id: randomParticipantId() })
	const links = new Map<LinkId, RoomLink>()
	const beaconOffers = new Map<string, RoomLink>()
	const [linkRevision, setLinkRevision] = createSignal(0)
	const [participantKeys, setParticipantKeys] = createSignal<ParticipantKey[]>([
		hostParticipant.id,
	])
	const [localKey, setLocalKey] = createSignal<ParticipantKey | null>(
		hostParticipant.id,
	)
	const [participants, setParticipants] = createStore<ParticipantsStore>({
		[hostParticipant.id]: hostParticipant,
	})
	const [state, setState] = createStore(emptyRoomState(hostParticipant.id))

	const roomSeed = {
		beaconOffers,
		beaconRendezvous: null,
		hostParticipantId: hostParticipant.participantId,
		linkSequence: 0,
		links,
		localKey,
		localParticipantId: hostParticipant.participantId,
		participantKeys,
		participants,
		roomKeys: null,
		roomSecret: null,
		setLocalKey,
		setParticipantKeys,
		setParticipants,
		setState,
		signalingVersion: 0,
		state,
	} satisfies RoomRuntimeSeed
	const room = roomSeed as RoomRuntime

	room.touchLinks = () => {
		// Links are mutable on purpose; this is the one Solid wake-up bell.
		setLinkRevision((revision) => revision + 1)
	}

	room.participantByKey = (key) => participants[key] ?? null

	room.participantById = (participantId) => {
		return participantId == null
			? null
			: room.participantByKey(participantKey(participantId))
	}

	room.selfActivity = createMemo(() => {
		// Before welcome, the composer is local-only; self has no room activity yet.
		const key = localKey()
		return key == null
			? emptyParticipantActivity()
			: (room.participantByKey(key)?.activity ?? emptyParticipantActivity())
	})

	room.isSelfHost = () => {
		// Hostness is identity, not which card is currently visible.
		return (
			room.localParticipantId != null &&
			room.localParticipantId === room.hostParticipantId
		)
	}

	room.isSelfGuest = () => {
		// A welcomed guest has both ids, and they differ.
		return (
			room.localParticipantId != null &&
			room.hostParticipantId != null &&
			room.localParticipantId !== room.hostParticipantId
		)
	}

	room.currentRendezvousLink = (role?: LinkRole, source?: LinkSource) => {
		// There should be at most one open invite lane for a given path.
		return findRendezvousLink(links.values(), role, source)
	}

	room.linkByParticipantKey = (key) => {
		return findParticipantLink(links.values(), key)
	}

	room.linkedPeers = () => [...links.values()].map((link) => link.peer)

	room.removeLink = (link) => {
		// Remove means "stop routing"; closeLink adds browser teardown.
		if (links.get(link.id) !== link) return

		link.live = false
		links.delete(link.id)
		for (const [offerId, offerLink] of beaconOffers) {
			if (offerLink === link) beaconOffers.delete(offerId)
		}
		room.touchLinks()
	}

	room.closeLink = (link) => {
		// Close from our side should still clean room bookkeeping first.
		room.removeLink(link)

		try {
			link.peer.close()
		} catch {}
	}

	room.closeRendezvousLink = (role?: LinkRole, source?: LinkSource) => {
		// Replacing an invite should not disturb established mesh links.
		const link = room.currentRendezvousLink(role, source)
		if (link != null) room.closeLink(link)
	}

	room.closeAllLinks = () => {
		// Snapshot first; close callbacks may try to mutate the same map.
		const closingLinks = [...links.values()]
		links.clear()
		beaconOffers.clear()
		for (const link of closingLinks) link.live = false
		room.touchLinks()

		for (const link of closingLinks) {
			try {
				link.peer.close()
			} catch {}
		}
	}

	room.stopBeaconRendezvous = () => {
		// Beacon candidates are meaningless once the beacon loop stops.
		room.beaconRendezvous?.close()
		room.beaconRendezvous = null
		beaconOffers.clear()
	}

	room.participantLink = (participantId) => {
		// Most protocol packets name participants, not link ids.
		return room.linkByParticipantKey(participantKey(participantId))
	}

	room.adoptLink = (link: RoomLink, participantId: ParticipantId) => {
		// Adoption needs a participant record first, then enforces one link per person.
		if (links.get(link.id) !== link) return false
		if (link.remoteId != null && link.remoteId !== participantId) return false

		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return false

		const existing = room.linkByParticipantKey(key)
		if (existing != null && existing !== link) room.closeLink(existing)

		link.remoteId = participantId
		for (const [offerId, offerLink] of beaconOffers) {
			if (offerLink === link) beaconOffers.delete(offerId)
		}
		room.touchLinks()
		return true
	}

	room.closeSiblingRendezvousLinks = (link) => {
		// Once one candidate wins a doorway, parallel candidates there retire.
		for (const candidate of [...links.values()]) {
			if (candidate === link) continue
			if (candidate.remoteId != null) continue
			if (candidate.role !== link.role) continue
			if (candidate.source !== link.source) continue
			if (
				link.source === 'beacon' &&
				(candidate.beaconPeerId == null ||
					link.beaconPeerId == null ||
					candidate.beaconPeerId !== link.beaconPeerId)
			) {
				continue
			}

			room.closeLink(candidate)
		}
	}

	room.replaceParticipants = (roster) => {
		// The host owns membership; guests keep local activity while matching it.
		const nextKeys = roster.map((person) => participantKey(person.id))
		const nextKeySet = new Set(nextKeys)
		const host =
			room.hostParticipantId == null
				? null
				: participantKey(room.hostParticipantId)
		const nextParticipants: ParticipantsStore = {}

		for (const key of participantKeys()) {
			if (key === host || nextKeySet.has(key)) continue

			const link = room.linkByParticipantKey(key)
			if (link != null) room.closeLink(link)
		}

		for (const person of roster) {
			const key = participantKey(person.id)
			const existing = participants[key]
			nextParticipants[key] = mergeParticipant(person, existing)
		}

		setParticipants(reconcile(nextParticipants))
		setParticipantKeys(nextKeys)
	}

	room.deleteParticipant = (participantId) => {
		// Remove the card first; callers may still close the old peer afterward.
		const key = participantKey(participantId)
		const link = room.participantLink(participantId)

		if (link != null) room.removeLink(link)
		setParticipantKeys((keys) => keys.filter((item) => item !== key))
		setParticipants(key, undefined)

		return link
	}

	room.allocateParticipantId = () => {
		// The host hands guests ids so all peers agree on the same roster.
		while (true) {
			const id = randomParticipantId()
			if (id === room.localParticipantId) continue
			if (id === room.hostParticipantId) continue
			if (participants[participantKey(id)] != null) continue

			return id
		}
	}

	room.roomRoster = () => {
		// Send only protocol identity; activity moves as live packets.
		return participantKeys()
			.map((key) => participants[key])
			.filter((person): person is RoomParticipant => person != null)
			.map(rosterParticipant)
	}

	room.liveParticipantLinks = () => {
		// Common packets go only to people, not invite candidates.
		return liveIdentifiedLinks(links.values())
	}

	room.liveParticipantLinkCount = () => room.liveParticipantLinks().length

	room.sendToParticipant = (participantId, packet) => {
		// Missing links are normal while the mesh is still forming.
		const link = room.participantLink(participantId)
		if (link == null || !link.live) return false

		return sendPacket(link.peer, packet)
	}

	room.sendToLinks = (targetLinks, packet) => {
		// Return a count so file sends can fail fast when everyone disappears.
		let sent = 0

		for (const link of targetLinks) {
			if (link.live && sendPacket(link.peer, packet)) sent++
		}

		return sent
	}

	room.broadcastPacket = (packet, except = null) => {
		// Broadcast follows the roster order and skips the optional sender.
		const exceptKey = except == null ? null : participantKey(except)

		for (const key of participantKeys()) {
			const link = room.linkByParticipantKey(key)
			if (key === exceptKey || link == null || !link.live) continue

			sendPacket(link.peer, packet)
		}
	}

	room.broadcastMembershipChange = (options = {}) => {
		// Membership is a protocol commit, not any participant-store mutation.
		if (options.left != null) {
			room.broadcastPacket({ type: 'peer-left', id: options.left })
		}
		room.broadcastPacket({ type: 'roster', roster: room.roomRoster() })
	}

	room.setPeerMediaState = (participantId, mediaState) => {
		// Remote media state decorates the link because it is transport-adjacent.
		const link = room.participantLink(participantId)
		if (link == null) return

		link.mediaState = mediaState
		room.touchLinks()
	}

	room.setParticipantBlip = (participantId, text) => {
		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return

		const blip = text.trim()
		setParticipants(key, 'activity', 'blip', blip === '' ? null : blip)
	}

	room.sendLocalMediaStateToPeer = (
		peer,
		mediaState = selfMediaState(state.selfMedia),
	) => {
		return sendPacket(peer, { ...mediaState, type: 'media-state' })
	}

	room.verifyLink = (link) => {
		// After auth, normal room packets may pass on this candidate.
		link.auth = 'verified'
		link.authNonce = null
		room.touchLinks()
	}

	room.publishLocalMediaState = (
		mediaState = selfMediaState(state.selfMedia),
	) => {
		// When camera state changes, every live portrait should update.
		return room.sendToLinks(room.liveParticipantLinks(), {
			...mediaState,
			type: 'media-state',
		})
	}

	room.setBlipIssue = (issue) => {
		setState('blipComposer', 'issue', issue)
	}

	room.upsertParticipantFile = (participantId, nextFile) => {
		// File chips update in place so progress does not reorder the activity stack.
		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return

		setParticipants(key, 'activity', 'files', (files) => {
			const index = files.findIndex((item) => item.id === nextFile.id)
			if (index === -1) return [...files, nextFile]

			return files.map((item, itemIndex) =>
				itemIndex === index ? nextFile : item,
			)
		})
	}

	room.markLocalSendingFilesError = () => {
		// One failed drop marks any in-flight local chips as failed.
		const key = localKey()
		if (key == null) return

		const person = participants[key]
		if (person == null) return

		setParticipants(key, 'activity', 'files', (files) =>
			files.map((file) =>
				file.state === 'sending' ? { ...file, state: 'error' } : file,
			),
		)
	}

	room.createLink = (role, linkOptions = {}) => {
		// Create the transport first; the room role decides what it becomes.
		const source = linkOptions.source ?? 'manual'
		room.linkSequence++
		const id: LinkId = `${role}:${room.linkSequence}`
		const peer = createPeer({
			onOpen: () => runtimeOptions.linkEvents.onOpen(id),
			onMessage: (text) => runtimeOptions.linkEvents.onMessage(id, text),
			onRemoteMedia: (stream) => {
				// Remote media belongs to the link, because the participant may reconnect.
				const link = links.get(id)
				if (link == null) return

				link.mediaStream = stream
				room.touchLinks()
			},
			onState: (state) => {
				// Rendezvous failures are the hard ones to explain to users.
				const link = links.get(id)
				if (link == null) return
				if (link.source !== 'beacon' && link.role === 'mesh') return

				infoRoom('rtc.state', { link: linkLog(link), ...state })
			},
			onClose: () => runtimeOptions.linkEvents.onClose(id),
		})

		const link: RoomLink = {
			auth: linkOptions.auth ?? (source === 'beacon' ? 'pending' : 'verified'),
			authNonce: null,
			beaconPeerId: linkOptions.beaconPeerId ?? null,
			id,
			live: false,
			mediaState: null,
			mediaStream: null,
			peer,
			remoteId: linkOptions.remoteId ?? null,
			role,
			source,
		}
		links.set(id, link)
		room.touchLinks()
		// New links should inherit any already-enabled camera/mic immediately.
		peer.setLocalMedia(state.selfMedia.stream)
		return link
	}

	const peerByKey = (key: ParticipantKey): RoomPeer | null => {
		const participant = room.participantByKey(key)
		if (participant == null) return null

		// Link state decides whether a person is live; participant state decides what they showed.
		linkRevision()
		const link = room.linkByParticipantKey(key)
		return {
			activity: participant.activity,
			connectionState: link?.live ? 'live' : 'waiting',
			id: participant.id,
			mediaState: link?.mediaState ?? null,
			mediaStream: link?.mediaStream ?? null,
		}
	}

	room.peers = createMemo(() => {
		const local = localKey()
		return participantKeys()
			.filter((key) => key !== local)
			.flatMap((key) => {
				const peer = peerByKey(key)
				return peer == null ? [] : [peer]
			})
	})

	room.beaconAuth = createBeaconAuth({
		closeLink: room.closeLink,
		linkStillCurrent: (link) => links.get(link.id) === link,
		roomKeys: () => room.roomKeys,
		verifyLink: room.verifyLink,
	})

	room.blips = createRoomBlips({
		getComposerText: () => state.blipComposer.text,
		getLocalParticipantId: () => room.localParticipantId,
		liveParticipantLinks: room.liveParticipantLinks,
		participantById: room.participantById,
		sendToLinks: room.sendToLinks,
		setBlipIssue: room.setBlipIssue,
		setComposerText: (text) => setState('blipComposer', 'text', text),
		setParticipantBlip: room.setParticipantBlip,
	})

	room.fileTransfers = createRoomFileTransfers({
		liveParticipantLinks: room.liveParticipantLinks,
		localParticipantId: () => room.localParticipantId,
		markLocalSendingFilesError: room.markLocalSendingFilesError,
		sendToLinks: room.sendToLinks,
		setBlipIssue: room.setBlipIssue,
		upsertParticipantFile: room.upsertParticipantFile,
	})

	room.createMeshLink = (participantId) => {
		// Mesh links skip rendezvous; the roster already names the target.
		const link = room.createLink('mesh', { remoteId: participantId })

		if (room.participantById(participantId) == null) {
			warnRoom('mesh.link.unknown-participant', {
				participantId: participantIdToString(participantId),
			})
			room.closeLink(link)
			return null
		}

		return link
	}

	room.sendToHost = (message) => {
		if (room.hostParticipantId == null) return false
		return room.sendToParticipant(room.hostParticipantId, message)
	}

	room.mesh = createRoomMesh({
		closeLink: room.closeLink,
		createMeshLink: room.createMeshLink,
		hostParticipantId: () => room.hostParticipantId,
		isSelfGuest: room.isSelfGuest,
		linkByParticipantKey: room.linkByParticipantKey,
		localParticipantId: () => room.localParticipantId,
		participantByKey: room.participantByKey,
		participantKeys,
		participantLink: room.participantLink,
		sendToHost: room.sendToHost,
	})

	room.media = createRoomMediaController({
		getSelfMedia: () => state.selfMedia,
		linkedPeers: room.linkedPeers,
		publishLocalMediaState: room.publishLocalMediaState,
		setSelfMedia: (selfMedia) => setState('selfMedia', selfMedia),
		setSelfMediaField: (key, value) => setState('selfMedia', key, value),
	})

	room.handleCommonMessage = (participantId, message) => {
		// Blips and files are symmetric; only connection setup needs host/guest ceremony.
		switch (message.type) {
			case 'blip':
				room.setParticipantBlip(participantId, message.text)
				return true
			case 'media-state':
				room.setPeerMediaState(participantId, {
					cameraEnabled: message.cameraEnabled,
					microphoneEnabled: message.microphoneEnabled,
					screenEnabled: message.screenEnabled,
				})
				return true
			case 'file-start':
				room.fileTransfers.handleFileStart(participantId, message)
				return true
			case 'file-chunk':
				room.fileTransfers.handleFileChunk(message)
				return true
			case 'file-end':
				room.fileTransfers.handleFileEnd(message)
				return true
			default:
				return false
		}
	}

	room.assignGuestParticipant = (): Participant => {
		return { id: room.allocateParticipantId() }
	}

	return room
}
