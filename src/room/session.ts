import { createMemo, createSignal } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import type { ExchangeId } from '../../contracts/beacon'
import { log } from '../log'
import {
	encodePacket,
	type Packet,
	type ParticipantId,
	type Roster,
} from '../protocol'
import type { BeaconClient } from '../rendezvous/beacon'
import type { RoomKeys } from '../rendezvous/crypto'
import type { RoomSecret } from '../rendezvous/secret'
import { createRtcPeer, type RtcPeer } from '../webrtc'
import { createRoomBlips, type TransferIssue } from './activity/blip'
import { createRoomFileTransfers } from './activity/files'
import {
	createRoomMediaController,
	type MediaPresence,
	selfMediaState,
} from './activity/media'
import { createBeaconAuth } from './entry/auth'
import { emptyRoomState } from './initial-state'
import {
	type AdmissionPath,
	type AdmissionSide,
	findAdmissionLink,
	findParticipantLink,
	isAdmissionLink,
	isBeaconAdmissionLink,
	isParticipantLink,
	type LinkId,
	type LinkPurpose,
	openParticipantLinks,
	type RoomLink,
} from './link'
import { createRoomMesh } from './mesh'
import {
	emptyParticipantActivity,
	mergeParticipant,
	type ParticipantActivity,
	type ParticipantFile,
	type ParticipantState,
	type ParticipantView,
	randomParticipantId,
} from './participant'
import { createRoomRelay } from './relay'

type ParticipantsStore = Partial<Record<ParticipantId, ParticipantState>>
type AdmissionQuery = {
	side?: AdmissionSide
	via?: AdmissionPath
}

/** WebRTC link callbacks bound during synchronous room assembly. */
export type RoomLinkEvents = {
	onClose: (linkId: LinkId) => void
	onMessage: (linkId: LinkId, text: string) => void
	onOpen: (linkId: LinkId) => void
}

/** Create the room session and its cohesive identity, participant, link, and UI ledgers. */
export const createRoomSession = () => {
	const hostParticipant = mergeParticipant(randomParticipantId())
	const links = new Map<LinkId, RoomLink>()
	const beaconExchanges = new Map<ExchangeId, RoomLink>()
	let linkEvents: RoomLinkEvents | null = null
	let linkSequence = 0
	const [linkRevision, setLinkRevision] = createSignal(0)
	const [participantIds, setParticipantIds] = createSignal<ParticipantId[]>([
		hostParticipant.id,
	])
	const [localId, setLocalId] = createSignal<ParticipantId | null>(
		hostParticipant.id,
	)
	const [participants, setParticipants] = createStore<ParticipantsStore>({
		[hostParticipant.id]: hostParticipant,
	})
	const [state, setState] = createStore(emptyRoomState(hostParticipant.id))
	const session = {
		beaconClient: null as BeaconClient | null,
		hostId: hostParticipant.id as ParticipantId | null,
		inviteSecret: null as RoomSecret | null,
		keys: null as RoomKeys | null,
		signalingGeneration: 0,
		get selfId() {
			return localId()
		},
		set selfId(participantId: ParticipantId | null) {
			setLocalId(participantId)
		},
		isGuest: () => {
			return (
				session.selfId != null &&
				session.hostId != null &&
				session.selfId !== session.hostId
			)
		},
		isHost: () => {
			return session.selfId != null && session.selfId === session.hostId
		},
		isCurrentSignalingGeneration: (generation: number) => {
			return generation === session.signalingGeneration
		},
		nextSignalingGeneration: () => ++session.signalingGeneration,
		stopBeacon: () => {
			session.beaconClient?.close()
			session.beaconClient = null
			beaconExchanges.clear()
		},
	}
	const relay = createRoomRelay({
		links,
		onStatsError: (error, link) => {
			log('warn', 'room', 'relay.stats.failed', { error, link })
		},
		setMetering: (metering) => setState('relayMetering', metering),
	})

	const notifyLinksChanged = () => {
		// Links are mutable on purpose; this is the one Solid wake-up bell.
		setLinkRevision((revision) => revision + 1)
	}

	const events = () => {
		if (linkEvents == null) throw new Error('Room link events are not bound')
		return linkEvents
	}

	const participantById = (
		participantId: ParticipantId | null,
	): ParticipantState | null => {
		return participantId == null ? null : (participants[participantId] ?? null)
	}

	const selfActivity = createMemo(() => {
		// Before welcome, the composer is local-only; self has no room activity yet.
		const id = localId()
		return id == null
			? emptyParticipantActivity()
			: (participantById(id)?.activity ?? emptyParticipantActivity())
	})

	const pendingLink = (query: AdmissionQuery = {}) => {
		// There should be at most one open invite lane for a given path.
		return findAdmissionLink(links.values(), query)
	}

	const linkByParticipantId = (participantId: ParticipantId) => {
		return findParticipantLink(links.values(), participantId)
	}

	const linkedPeers = () => [...links.values()].map((link) => link.rtc)

	const removeLink = (link: RoomLink) => {
		// Remove means "stop routing"; closeLink adds browser teardown.
		if (links.get(link.id) !== link) return

		link.channelOpen = false
		links.delete(link.id)
		for (const [exchangeId, exchangeLink] of beaconExchanges) {
			if (exchangeLink === link) beaconExchanges.delete(exchangeId)
		}
		notifyLinksChanged()
	}

	const closeLink = (link: RoomLink) => {
		// Close from our side should still clean room bookkeeping first.
		removeLink(link)

		try {
			link.rtc.close()
		} catch {}
	}

	const closePendingLink = (query: AdmissionQuery = {}) => {
		// Replacing an invite should not disturb established mesh links.
		const link = pendingLink(query)
		if (link != null) closeLink(link)
	}

	const closeAllLinks = () => {
		// Snapshot first; close callbacks may try to mutate the same map.
		const closingLinks = [...links.values()]
		links.clear()
		beaconExchanges.clear()
		for (const link of closingLinks) link.channelOpen = false
		notifyLinksChanged()

		for (const link of closingLinks) {
			try {
				link.rtc.close()
			} catch {}
		}
	}

	const participantLink = (participantId: ParticipantId) => {
		// Most protocol packets name participants, not link ids.
		return linkByParticipantId(participantId)
	}

	const adoptLink = (link: RoomLink, participantId: ParticipantId) => {
		// Adoption needs a participant record first, then enforces one link per person.
		if (links.get(link.id) !== link) return false
		if (
			isParticipantLink(link) &&
			link.purpose.participantId !== participantId
		) {
			return false
		}
		if (!isAdmissionLink(link) && !isParticipantLink(link)) return false

		const person = participants[participantId]
		if (person == null) return false

		const existing = linkByParticipantId(participantId)
		if (existing != null && existing !== link) closeLink(existing)

		link.purpose = {
			kind: 'participant',
			participantId,
			via: isAdmissionLink(link) ? 'admission' : link.purpose.via,
		}
		for (const [exchangeId, exchangeLink] of beaconExchanges) {
			if (exchangeLink === link) beaconExchanges.delete(exchangeId)
		}
		notifyLinksChanged()
		return true
	}

	const closeSiblingAdmissionLinks = (link: RoomLink) => {
		// Once one candidate wins a doorway, parallel candidates there retire.
		if (!isAdmissionLink(link)) return

		for (const candidate of [...links.values()]) {
			if (candidate === link) continue
			if (!isAdmissionLink(candidate)) continue
			if (candidate.purpose.side !== link.purpose.side) continue
			if (candidate.purpose.via !== link.purpose.via) continue
			if (
				isBeaconAdmissionLink(link) &&
				isBeaconAdmissionLink(candidate) &&
				(candidate.purpose.peerId == null ||
					link.purpose.peerId == null ||
					candidate.purpose.peerId !== link.purpose.peerId)
			) {
				continue
			}

			closeLink(candidate)
		}
	}

	const replaceParticipants = (roster: Roster) => {
		// The host owns membership; guests keep local activity while matching it.
		const nextIds = roster
		const nextIdSet = new Set(nextIds)
		const host = session.hostId
		const nextParticipants: ParticipantsStore = {}

		for (const id of participantIds()) {
			if (id === host || nextIdSet.has(id)) continue

			const link = linkByParticipantId(id)
			if (link != null) closeLink(link)
		}

		for (const id of roster) {
			const existing = participants[id]
			nextParticipants[id] = mergeParticipant(id, existing ?? null)
		}

		setParticipants(reconcile(nextParticipants))
		setParticipantIds(nextIds)
	}

	const removeParticipant = (participantId: ParticipantId) => {
		// Membership and its transport leave together so callers cannot keep a ghost card.
		const link = participantLink(participantId)

		setParticipantIds((ids) => ids.filter((item) => item !== participantId))
		setParticipants(participantId, void null)
		if (link != null) closeLink(link)
	}

	const allocateParticipantId = () => {
		// The host hands guests ids so all peers agree on the same roster.
		while (true) {
			const id = randomParticipantId()
			if (id === session.selfId) continue
			if (id === session.hostId) continue
			if (participants[id] != null) continue

			return id
		}
	}

	const roomRoster = () => {
		// Send only protocol identity; activity moves as live packets.
		return participantIds()
	}

	const participantLinksOpen = () => {
		// Common packets go only to people, not invite candidates.
		return openParticipantLinks(links.values())
	}

	const openParticipantLinkCount = () => participantLinksOpen().length

	const sendToParticipant = (participantId: ParticipantId, packet: Packet) => {
		// Missing links are normal while the mesh is still forming.
		const link = participantLink(participantId)
		if (link == null || !link.channelOpen) return false

		return link.rtc.trySend(encodePacket(packet))
	}

	const sendToLinks = (targetLinks: RoomLink[], packet: Packet) => {
		// Return a count so file sends can fail fast when everyone disappears.
		let sent = 0

		for (const link of targetLinks) {
			if (link.channelOpen && link.rtc.trySend(encodePacket(packet))) sent++
		}

		return sent
	}

	const broadcastPacket = (
		packet: Packet,
		except: ParticipantId | null = null,
	) => {
		// Broadcast follows the roster order and skips the optional sender.
		for (const id of participantIds()) {
			const link = linkByParticipantId(id)
			if (id === except || link == null || !link.channelOpen) continue

			link.rtc.trySend(encodePacket(packet))
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

	const setMediaPresence = (
		participantId: ParticipantId,
		mediaState: MediaPresence,
	) => {
		// Remote media state decorates the link because it is transport-adjacent.
		const link = participantLink(participantId)
		if (link == null) return

		link.media = { state: mediaState, stream: link.media?.stream ?? null }
		notifyLinksChanged()
	}

	const updateParticipantActivity = (
		participantId: ParticipantId,
		update: (activity: ParticipantActivity) => ParticipantActivity,
	) => {
		const person = participants[participantId]
		if (person == null) return

		setParticipants(participantId, 'activity', update)
	}

	const setParticipantBlip = (participantId: ParticipantId, text: string) => {
		const blip = text.trim()
		updateParticipantActivity(participantId, (activity) => ({
			...activity,
			blip: blip === '' ? null : blip,
		}))
	}

	const sendLocalMediaStateToPeer = (
		peer: RtcPeer,
		mediaState: MediaPresence = selfMediaState(state.selfMedia),
	) => {
		return peer.trySend(encodePacket({ ...mediaState, type: 'media-state' }))
	}

	const verifyLink = (link: RoomLink) => {
		// After auth, normal room packets may pass on this candidate.
		if (!isBeaconAdmissionLink(link)) return
		link.purpose.auth = 'verified'
		notifyLinksChanged()
	}

	const publishLocalMediaState = (
		mediaState: MediaPresence = selfMediaState(state.selfMedia),
	) => {
		// When camera state changes, every live portrait should update.
		return sendToLinks(participantLinksOpen(), {
			...mediaState,
			type: 'media-state',
		})
	}

	const setBlipIssue = (issue: TransferIssue | null) => {
		setState('blipComposer', 'issue', issue)
	}

	const upsertParticipantFile = (
		participantId: ParticipantId,
		nextFile: ParticipantFile,
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

	const markLocalSendingFilesError = () => {
		// One failed drop marks any in-flight local chips as failed.
		if (session.selfId == null) return

		updateParticipantActivity(session.selfId, (activity) => ({
			...activity,
			files: activity.files.map((file) =>
				file.state === 'sending' ? { ...file, state: 'error' } : file,
			),
		}))
	}

	const createLink = (purpose: LinkPurpose) => {
		// Create the transport first; the room role decides what it becomes.
		linkSequence++
		const id: LinkId = `${purpose.kind}:${linkSequence}`
		const peer = createRtcPeer({
			...relay.peerOptions(),
			onOpen: () => events().onOpen(id),
			onMessage: (text) => events().onMessage(id, text),
			onRemoteMedia: (stream) => {
				// Remote media belongs to the link, because the participant may reconnect.
				const link = links.get(id)
				if (link == null) return

				link.media = { state: link.media?.state ?? null, stream }
				notifyLinksChanged()
			},
			onState: (state) => {
				// Rendezvous failures are the hard ones to explain to users.
				const link = links.get(id)
				if (link == null) return
				if (
					link.purpose.kind === 'participant' &&
					link.purpose.via === 'mesh'
				) {
					return
				}

				log('info', 'room', 'rtc.state', { link, ...state })
			},
			onClose: () => events().onClose(id),
		})

		const link: RoomLink = {
			channelOpen: false,
			id,
			media: null,
			purpose,
			rtc: peer,
		}
		links.set(id, link)
		notifyLinksChanged()
		// New links should inherit any already-enabled camera/mic immediately.
		peer.setLocalMedia(state.selfMedia.outboundStream)
		return link
	}

	const peerById = (id: ParticipantId): ParticipantView | null => {
		const participant = participantById(id)
		if (participant == null) return null

		// Link state decides whether a person is live; participant state decides what they showed.
		linkRevision()
		const link = linkByParticipantId(id)
		return {
			activity: participant.activity,
			connectionState: link?.channelOpen ? 'live' : 'waiting',
			id: participant.id,
			mediaState: link?.media?.state ?? null,
			mediaStream: link?.media?.stream ?? null,
		}
	}

	const peers = createMemo(() => {
		const local = localId()
		return participantIds()
			.filter((id) => id !== local)
			.flatMap((id) => {
				const peer = peerById(id)
				return peer == null ? [] : [peer]
			})
	})

	const createMeshLink = (participantId: ParticipantId) => {
		// Mesh links skip rendezvous; the roster already names the target.
		const link = createLink({
			kind: 'participant',
			participantId,
			via: 'mesh',
		})

		if (participantById(participantId) == null) {
			log('warn', 'room', 'mesh.link.unknown-participant', {
				participantId,
			})
			closeLink(link)
			return null
		}

		return link
	}

	const sendToHost = (message: Packet) => {
		if (session.hostId == null) return false
		return sendToParticipant(session.hostId, message)
	}

	const handleCommonMessage = (
		participantId: ParticipantId,
		message: Packet,
	) => {
		// Blips and files are symmetric; only connection setup needs host/guest ceremony.
		switch (message.type) {
			case 'blip':
				setParticipantBlip(participantId, message.text)
				return true
			case 'media-state':
				setMediaPresence(participantId, {
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

	const beaconAuth = createBeaconAuth({
		closeLink,
		linkStillCurrent: (link) => links.get(link.id) === link,
		roomKeys: () => session.keys,
		verifyLink,
	})

	const blips = createRoomBlips({
		getComposerText: () => state.blipComposer.text,
		getLocalParticipantId: () => session.selfId,
		openParticipantLinks: participantLinksOpen,
		participantById,
		sendToLinks,
		setBlipIssue,
		setComposerText: (text) => setState('blipComposer', 'text', text),
		setParticipantBlip,
	})

	const fileTransfers = createRoomFileTransfers({
		localParticipantId: () => session.selfId,
		markLocalSendingFilesError,
		openParticipantLinks: participantLinksOpen,
		sendToLinks,
		setBlipIssue,
		upsertParticipantFile,
	})

	const mesh = createRoomMesh({
		closeLink,
		createMeshLink,
		hostParticipantId: () => session.hostId,
		isSelfGuest: session.isGuest,
		linkByParticipantId,
		localParticipantId: () => session.selfId,
		participantIds,
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

	return {
		auth: beaconAuth,
		blips,
		files: fileTransfers,
		links: {
			adopt: adoptLink,
			bind: (events: RoomLinkEvents) => {
				if (linkEvents != null)
					throw new Error('Room link events already bound')
				linkEvents = events
			},
			close: closeLink,
			closeAll: closeAllLinks,
			closePending: closePendingLink,
			closeSiblingAdmissions: closeSiblingAdmissionLinks,
			countOpenParticipants: openParticipantLinkCount,
			create: createLink,
			exchanges: beaconExchanges,
			forParticipant: participantLink,
			linkedRtc: linkedPeers,
			notifyChanged: notifyLinksChanged,
			openParticipants: participantLinksOpen,
			pending: pendingLink,
			records: links,
			remove: removeLink,
		},
		media,
		mesh,
		packets: {
			broadcast: broadcastPacket,
			broadcastMembershipChange,
			handleCommon: handleCommonMessage,
			publishLocalMediaState,
			sendLocalMediaStateToRtc: sendLocalMediaStateToPeer,
			sendToHost,
			sendToLinks,
			sendToParticipant,
		},
		participants: {
			allocateId: allocateParticipantId,
			get: participantById,
			ids: participantIds,
			records: participants,
			remove: removeParticipant,
			replace: replaceParticipants,
			roster: roomRoster,
			selfActivity,
			setBlip: setParticipantBlip,
			setIds: setParticipantIds,
			setRecords: setParticipants,
			upsertFile: upsertParticipantFile,
			views: peers,
		},
		relay,
		session,
		ui: { setState, state },
	}
}

export type RoomSession = ReturnType<typeof createRoomSession>
