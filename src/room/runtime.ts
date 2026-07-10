import { type Accessor, createMemo, createSignal, type Setter } from 'solid-js'
import {
	createStore,
	reconcile,
	type SetStoreFunction,
	type Store,
} from 'solid-js/store'
import { log } from '../log'
import {
	encodePacket,
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
	isBeaconLink,
	isParticipantLink,
	type LinkAuthState,
	type LinkId,
	type LinkRole,
	type LinkSource,
	openParticipantLinks,
	type RoomLink,
} from './link'
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
import { createRoomRelay, type RoomRelay } from './relay'
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
	readonly beaconAuth: BeaconAuth
	beaconOffers: Map<string, RoomLink>
	beaconRendezvous: BeaconRendezvous | null
	readonly blips: RoomBlips
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
	readonly fileTransfers: RoomFileTransfers
	handleCommonMessage: (
		participantId: ParticipantId,
		message: Packet,
	) => boolean
	hostParticipantId: ParticipantId | null
	isCurrentSignalingVersion: (version: number) => boolean
	isSelfGuest: () => boolean
	isSelfHost: () => boolean
	linkByParticipantKey: (key: ParticipantKey) => RoomLink | null
	linkSequence: number
	links: Map<LinkId, RoomLink>
	linkedPeers: () => Peer[]
	openParticipantLinkCount: () => number
	openParticipantLinks: () => RoomLink[]
	localKey: Accessor<ParticipantKey | null>
	localParticipantId: ParticipantId | null
	markLocalSendingFilesError: () => void
	readonly media: RoomMediaController
	readonly mesh: RoomMesh
	nextSignalingVersion: () => number
	participantById: (
		participantId: ParticipantId | null,
	) => RoomParticipant | null
	participantByKey: (key: ParticipantKey) => RoomParticipant | null
	participantKeys: Accessor<ParticipantKey[]>
	participantLink: (participantId: ParticipantId) => RoomLink | null
	participants: Store<ParticipantsStore>
	peers: Accessor<RoomPeer[]>
	publishLocalMediaState: (mediaState?: PeerMediaState) => number
	relay: RoomRelay
	removeLink: (link: RoomLink) => void
	removeParticipant: (participantId: ParticipantId) => void
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
	notifyLinksChanged: () => void
	upsertParticipantFile: (
		participantId: ParticipantId,
		nextFile: PortraitFileState,
	) => void
	verifyLink: (link: RoomLink) => void
}

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
	const relay = createRoomRelay({
		links,
		onStatsError: (error, link) => {
			log('warn', 'room', 'relay.stats.failed', { error, link })
		},
		setMetering: (metering) => setState('relayMetering', metering),
	})

	const notifyLinksChanged: RoomRuntime['notifyLinksChanged'] = () => {
		// Links are mutable on purpose; this is the one Solid wake-up bell.
		setLinkRevision((revision) => revision + 1)
	}

	const participantByKey: RoomRuntime['participantByKey'] = (key) =>
		participants[key] ?? null

	const participantById: RoomRuntime['participantById'] = (participantId) => {
		return participantId == null
			? null
			: participantByKey(participantKey(participantId))
	}

	const selfActivity = createMemo(() => {
		// Before welcome, the composer is local-only; self has no room activity yet.
		const key = localKey()
		return key == null
			? emptyParticipantActivity()
			: (participantByKey(key)?.activity ?? emptyParticipantActivity())
	})

	const isSelfHost: RoomRuntime['isSelfHost'] = () => {
		// Hostness is identity, not which card is currently visible.
		return (
			room.localParticipantId != null &&
			room.localParticipantId === room.hostParticipantId
		)
	}

	const isSelfGuest: RoomRuntime['isSelfGuest'] = () => {
		// A welcomed guest has both ids, and they differ.
		return (
			room.localParticipantId != null &&
			room.hostParticipantId != null &&
			room.localParticipantId !== room.hostParticipantId
		)
	}

	const nextSignalingVersion: RoomRuntime['nextSignalingVersion'] = () => {
		// Invite/reply/beacon attempts share one cancellation clock.
		return ++room.signalingVersion
	}

	const isCurrentSignalingVersion: RoomRuntime['isCurrentSignalingVersion'] = (
		version,
	) => {
		return version === room.signalingVersion
	}

	const currentRendezvousLink: RoomRuntime['currentRendezvousLink'] = (
		role,
		source,
	) => {
		// There should be at most one open invite lane for a given path.
		return findRendezvousLink(links.values(), role, source)
	}

	const linkByParticipantKey: RoomRuntime['linkByParticipantKey'] = (key) => {
		return findParticipantLink(links.values(), key)
	}

	const linkedPeers: RoomRuntime['linkedPeers'] = () =>
		[...links.values()].map((link) => link.peer)

	const removeLink: RoomRuntime['removeLink'] = (link) => {
		// Remove means "stop routing"; closeLink adds browser teardown.
		if (links.get(link.id) !== link) return

		link.channelOpen = false
		links.delete(link.id)
		for (const [offerId, offerLink] of beaconOffers) {
			if (offerLink === link) beaconOffers.delete(offerId)
		}
		notifyLinksChanged()
	}

	const closeLink: RoomRuntime['closeLink'] = (link) => {
		// Close from our side should still clean room bookkeeping first.
		removeLink(link)

		try {
			link.peer.close()
		} catch {}
	}

	const closeRendezvousLink: RoomRuntime['closeRendezvousLink'] = (
		role,
		source,
	) => {
		// Replacing an invite should not disturb established mesh links.
		const link = currentRendezvousLink(role, source)
		if (link != null) closeLink(link)
	}

	const closeAllLinks: RoomRuntime['closeAllLinks'] = () => {
		// Snapshot first; close callbacks may try to mutate the same map.
		const closingLinks = [...links.values()]
		links.clear()
		beaconOffers.clear()
		for (const link of closingLinks) link.channelOpen = false
		notifyLinksChanged()

		for (const link of closingLinks) {
			try {
				link.peer.close()
			} catch {}
		}
	}

	const stopBeaconRendezvous: RoomRuntime['stopBeaconRendezvous'] = () => {
		// Beacon candidates are meaningless once the beacon loop stops.
		room.beaconRendezvous?.close()
		room.beaconRendezvous = null
		beaconOffers.clear()
	}

	const participantLink: RoomRuntime['participantLink'] = (participantId) => {
		// Most protocol packets name participants, not link ids.
		return linkByParticipantKey(participantKey(participantId))
	}

	const adoptLink: RoomRuntime['adoptLink'] = (link, participantId) => {
		// Adoption needs a participant record first, then enforces one link per person.
		if (links.get(link.id) !== link) return false
		if (isParticipantLink(link) && link.remoteId !== participantId) return false

		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return false

		const existing = linkByParticipantKey(key)
		if (existing != null && existing !== link) closeLink(existing)

		link.remoteId = participantId
		for (const [offerId, offerLink] of beaconOffers) {
			if (offerLink === link) beaconOffers.delete(offerId)
		}
		notifyLinksChanged()
		return true
	}

	const closeSiblingRendezvousLinks: RoomRuntime['closeSiblingRendezvousLinks'] =
		(link) => {
			// Once one candidate wins a doorway, parallel candidates there retire.
			for (const candidate of [...links.values()]) {
				if (candidate === link) continue
				if (isParticipantLink(candidate)) continue
				if (candidate.role !== link.role) continue
				if (candidate.source !== link.source) continue
				if (
					isBeaconLink(link) &&
					(candidate.beaconPeerId == null ||
						link.beaconPeerId == null ||
						candidate.beaconPeerId !== link.beaconPeerId)
				) {
					continue
				}

				closeLink(candidate)
			}
		}

	const replaceParticipants: RoomRuntime['replaceParticipants'] = (roster) => {
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

	const removeParticipant: RoomRuntime['removeParticipant'] = (
		participantId,
	) => {
		// Membership and its transport leave together so callers cannot keep a ghost card.
		const key = participantKey(participantId)
		const link = participantLink(participantId)

		setParticipantKeys((keys) => keys.filter((item) => item !== key))
		setParticipants(key, undefined)
		if (link != null) closeLink(link)
	}

	const allocateParticipantId: RoomRuntime['allocateParticipantId'] = () => {
		// The host hands guests ids so all peers agree on the same roster.
		while (true) {
			const id = randomParticipantId()
			if (id === room.localParticipantId) continue
			if (id === room.hostParticipantId) continue
			if (participants[participantKey(id)] != null) continue

			return id
		}
	}

	const roomRoster: RoomRuntime['roomRoster'] = () => {
		// Send only protocol identity; activity moves as live packets.
		return participantKeys()
			.map((key) => participants[key])
			.filter((person): person is RoomParticipant => person != null)
			.map(rosterParticipant)
	}

	const participantLinksOpen: RoomRuntime['openParticipantLinks'] = () => {
		// Common packets go only to people, not invite candidates.
		return openParticipantLinks(links.values())
	}

	const openParticipantLinkCount: RoomRuntime['openParticipantLinkCount'] =
		() => participantLinksOpen().length

	const sendToParticipant: RoomRuntime['sendToParticipant'] = (
		participantId,
		packet,
	) => {
		// Missing links are normal while the mesh is still forming.
		const link = participantLink(participantId)
		if (link == null || !link.channelOpen) return false

		return link.peer.trySend(encodePacket(packet))
	}

	const sendToLinks: RoomRuntime['sendToLinks'] = (targetLinks, packet) => {
		// Return a count so file sends can fail fast when everyone disappears.
		let sent = 0

		for (const link of targetLinks) {
			if (link.channelOpen && link.peer.trySend(encodePacket(packet))) sent++
		}

		return sent
	}

	const broadcastPacket: RoomRuntime['broadcastPacket'] = (
		packet,
		except = null,
	) => {
		// Broadcast follows the roster order and skips the optional sender.
		const exceptKey = except == null ? null : participantKey(except)

		for (const key of participantKeys()) {
			const link = linkByParticipantKey(key)
			if (key === exceptKey || link == null || !link.channelOpen) continue

			link.peer.trySend(encodePacket(packet))
		}
	}

	const broadcastMembershipChange: RoomRuntime['broadcastMembershipChange'] = (
		options = {},
	) => {
		// Membership is a protocol commit, not any participant-store mutation.
		if (options.left != null) {
			broadcastPacket({ type: 'peer-left', id: options.left })
		}
		broadcastPacket({ type: 'roster', roster: roomRoster() })
	}

	const setPeerMediaState: RoomRuntime['setPeerMediaState'] = (
		participantId,
		mediaState,
	) => {
		// Remote media state decorates the link because it is transport-adjacent.
		const link = participantLink(participantId)
		if (link == null) return

		link.mediaState = mediaState
		notifyLinksChanged()
	}

	const updateParticipantActivity = (
		participantId: ParticipantId,
		update: (activity: PortraitActivityState) => PortraitActivityState,
	) => {
		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return

		setParticipants(key, 'activity', update)
	}

	const setParticipantBlip: RoomRuntime['setParticipantBlip'] = (
		participantId,
		text,
	) => {
		const blip = text.trim()
		updateParticipantActivity(participantId, (activity) => ({
			...activity,
			blip: blip === '' ? null : blip,
		}))
	}

	const sendLocalMediaStateToPeer: RoomRuntime['sendLocalMediaStateToPeer'] = (
		peer,
		mediaState = selfMediaState(state.selfMedia),
	) => {
		return peer.trySend(encodePacket({ ...mediaState, type: 'media-state' }))
	}

	const verifyLink: RoomRuntime['verifyLink'] = (link) => {
		// After auth, normal room packets may pass on this candidate.
		link.auth = 'verified'
		link.authNonce = null
		notifyLinksChanged()
	}

	const publishLocalMediaState: RoomRuntime['publishLocalMediaState'] = (
		mediaState = selfMediaState(state.selfMedia),
	) => {
		// When camera state changes, every live portrait should update.
		return sendToLinks(participantLinksOpen(), {
			...mediaState,
			type: 'media-state',
		})
	}

	const setBlipIssue: RoomRuntime['setBlipIssue'] = (issue) => {
		setState('blipComposer', 'issue', issue)
	}

	const upsertParticipantFile: RoomRuntime['upsertParticipantFile'] = (
		participantId,
		nextFile,
	) => {
		// File chips update in place so progress does not reorder the activity stack.
		updateParticipantActivity(participantId, (activity) => {
			const files = activity.files
			const index = files.findIndex((item) => item.id === nextFile.id)
			const nextFiles =
				index === -1
					? [...files, nextFile]
					: files.map((item, itemIndex) =>
							itemIndex === index ? nextFile : item,
						)

			return { ...activity, files: nextFiles }
		})
	}

	const markLocalSendingFilesError: RoomRuntime['markLocalSendingFilesError'] =
		() => {
			// One failed drop marks any in-flight local chips as failed.
			if (room.localParticipantId == null) return

			updateParticipantActivity(room.localParticipantId, (activity) => ({
				...activity,
				files: activity.files.map((file) =>
					file.state === 'sending' ? { ...file, state: 'error' } : file,
				),
			}))
		}

	const createLink: RoomRuntime['createLink'] = (role, linkOptions = {}) => {
		// Create the transport first; the room role decides what it becomes.
		const source = linkOptions.source ?? 'manual'
		room.linkSequence++
		const id: LinkId = `${role}:${room.linkSequence}`
		const peer = createPeer({
			...relay.peerOptions(),
			onOpen: () => runtimeOptions.linkEvents.onOpen(id),
			onMessage: (text) => runtimeOptions.linkEvents.onMessage(id, text),
			onRemoteMedia: (stream) => {
				// Remote media belongs to the link, because the participant may reconnect.
				const link = links.get(id)
				if (link == null) return

				link.mediaStream = stream
				notifyLinksChanged()
			},
			onState: (state) => {
				// Rendezvous failures are the hard ones to explain to users.
				const link = links.get(id)
				if (link == null) return
				if (!isBeaconLink(link) && link.role === 'mesh') return

				log('info', 'room', 'rtc.state', { link, ...state })
			},
			onClose: () => runtimeOptions.linkEvents.onClose(id),
		})

		const link: RoomLink = {
			auth: linkOptions.auth ?? (source === 'beacon' ? 'pending' : 'verified'),
			authNonce: null,
			beaconPeerId: linkOptions.beaconPeerId ?? null,
			id,
			channelOpen: false,
			mediaState: null,
			mediaStream: null,
			peer,
			remoteId: linkOptions.remoteId ?? null,
			role,
			source,
		}
		links.set(id, link)
		notifyLinksChanged()
		// New links should inherit any already-enabled camera/mic immediately.
		peer.setLocalMedia(state.selfMedia.outboundStream)
		return link
	}

	const peerByKey = (key: ParticipantKey): RoomPeer | null => {
		const participant = participantByKey(key)
		if (participant == null) return null

		// Link state decides whether a person is live; participant state decides what they showed.
		linkRevision()
		const link = linkByParticipantKey(key)
		return {
			activity: participant.activity,
			connectionState: link?.channelOpen ? 'live' : 'waiting',
			id: participant.id,
			mediaState: link?.mediaState ?? null,
			mediaStream: link?.mediaStream ?? null,
		}
	}

	const peers = createMemo(() => {
		const local = localKey()
		return participantKeys()
			.filter((key) => key !== local)
			.flatMap((key) => {
				const peer = peerByKey(key)
				return peer == null ? [] : [peer]
			})
	})

	const createMeshLink: RoomRuntime['createMeshLink'] = (participantId) => {
		// Mesh links skip rendezvous; the roster already names the target.
		const link = createLink('mesh', { remoteId: participantId })

		if (participantById(participantId) == null) {
			log('warn', 'room', 'mesh.link.unknown-participant', {
				participantId: participantIdToString(participantId),
			})
			closeLink(link)
			return null
		}

		return link
	}

	const sendToHost: RoomRuntime['sendToHost'] = (message) => {
		if (room.hostParticipantId == null) return false
		return sendToParticipant(room.hostParticipantId, message)
	}

	const handleCommonMessage: RoomRuntime['handleCommonMessage'] = (
		participantId,
		message,
	) => {
		// Blips and files are symmetric; only connection setup needs host/guest ceremony.
		switch (message.type) {
			case 'blip':
				setParticipantBlip(participantId, message.text)
				return true
			case 'media-state':
				setPeerMediaState(participantId, {
					cameraEnabled: message.cameraEnabled,
					microphoneEnabled: message.microphoneEnabled,
					screenEnabled: message.screenEnabled,
				})
				return true
			case 'file-start':
				fileTransfers.handleFileStart(participantId, message)
				return true
			case 'file-chunk':
				fileTransfers.handleFileChunk(message)
				return true
			case 'file-end':
				fileTransfers.handleFileEnd(message)
				return true
			default:
				return false
		}
	}

	const assignGuestParticipant: RoomRuntime['assignGuestParticipant'] = () => {
		return { id: allocateParticipantId() }
	}

	// Service getters close the construction cycle; every factory is bound before return.
	const room: RoomRuntime = {
		adoptLink,
		allocateParticipantId,
		assignGuestParticipant,
		get beaconAuth() {
			return beaconAuth
		},
		beaconOffers,
		beaconRendezvous: null,
		get blips() {
			return blips
		},
		broadcastMembershipChange,
		broadcastPacket,
		closeAllLinks,
		closeLink,
		closeRendezvousLink,
		closeSiblingRendezvousLinks,
		createLink,
		createMeshLink,
		currentRendezvousLink,
		get fileTransfers() {
			return fileTransfers
		},
		handleCommonMessage,
		hostParticipantId: hostParticipant.participantId,
		isCurrentSignalingVersion,
		isSelfGuest,
		isSelfHost,
		linkByParticipantKey,
		linkSequence: 0,
		linkedPeers,
		links,
		localKey,
		localParticipantId: hostParticipant.participantId,
		markLocalSendingFilesError,
		get media() {
			return media
		},
		get mesh() {
			return mesh
		},
		nextSignalingVersion,
		notifyLinksChanged,
		openParticipantLinkCount,
		openParticipantLinks: participantLinksOpen,
		participantById,
		participantByKey,
		participantKeys,
		participantLink,
		participants,
		peers,
		publishLocalMediaState,
		relay,
		removeLink,
		removeParticipant,
		replaceParticipants,
		roomKeys: null,
		roomRoster,
		roomSecret: null,
		selfActivity,
		sendLocalMediaStateToPeer,
		sendToHost,
		sendToLinks,
		sendToParticipant,
		setBlipIssue,
		setLocalKey,
		setParticipantBlip,
		setParticipantKeys,
		setParticipants,
		setPeerMediaState,
		setState,
		signalingVersion: 0,
		state,
		stopBeaconRendezvous,
		upsertParticipantFile,
		verifyLink,
	}

	const beaconAuth = createBeaconAuth({
		closeLink,
		linkStillCurrent: (link) => links.get(link.id) === link,
		roomKeys: () => room.roomKeys,
		verifyLink,
	})

	const blips = createRoomBlips({
		getComposerText: () => state.blipComposer.text,
		getLocalParticipantId: () => room.localParticipantId,
		openParticipantLinks: participantLinksOpen,
		participantById,
		sendToLinks,
		setBlipIssue,
		setComposerText: (text) => setState('blipComposer', 'text', text),
		setParticipantBlip,
	})

	const fileTransfers = createRoomFileTransfers({
		localParticipantId: () => room.localParticipantId,
		markLocalSendingFilesError,
		openParticipantLinks: participantLinksOpen,
		sendToLinks,
		setBlipIssue,
		upsertParticipantFile,
	})

	const mesh = createRoomMesh({
		closeLink,
		createMeshLink,
		hostParticipantId: () => room.hostParticipantId,
		isSelfGuest,
		linkByParticipantKey,
		localParticipantId: () => room.localParticipantId,
		participantByKey,
		participantKeys,
		participantLink,
		sendToHost,
	})

	const media = createRoomMediaController({
		getSelfMedia: () => state.selfMedia,
		linkedPeers,
		publishLocalMediaState,
		setSelfMedia: (selfMedia) => setState('selfMedia', selfMedia),
		setSelfMediaField: (key, value) => setState('selfMedia', key, value),
	})

	return room
}
