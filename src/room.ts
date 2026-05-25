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
	type BeaconRendezvous,
	type BeaconStatus,
	createBeaconRendezvous,
} from './rendezvous/beacon'
import {
	deriveRoomKeys,
	type RoomKeys,
	randomNonce,
	signRoomAuth,
	verifyRoomAuth,
} from './rendezvous/crypto'
import { type RoomSecret, randomRoomSecret } from './rendezvous/secret'
import {
	createIncomingFileTransfer,
	FILE_BUFFER_LOW_BYTES,
	FILE_CHUNK_BYTES,
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
	copyText,
	inviteCodeFromSignal,
	inviteFromInput,
	inviteLinkFromSecret,
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
	captureScreenMedia,
	captureSelfMedia,
	emptySelfMedia,
	type SelfMedia,
	setSelfMediaTracksEnabled,
	stopMediaStream,
	stopSelfMedia,
	withActiveSelfMediaStream,
} from './self-media'
import { decodeSignal, encodeSignal, type SignalDescription } from './signal'
import type {
	PeerConnectionState,
	PeerMediaState,
	PortraitActivityState,
	PortraitFileState,
} from './state'
import { createPeer, type Peer } from './webrtc'

// This is the shape the strip renders: person facts plus their current transport.
export type RoomPeer = {
	activity: PortraitActivityState
	id: ParticipantKey
	mediaState?: PeerMediaState | null
	mediaStream?: MediaStream | null
	connectionState: PeerConnectionState
}

// Actions are UI verbs. They deliberately hide the host/guest ceremony below.
type RoomActions = {
	acceptReply: (replyText?: string) => void
	becomeGuest: () => void
	becomeHost: () => void
	copyInviteLink: () => void
	copyInviteCode: () => void
	copyReplyCode: () => void
	createReply: (inviteText?: string) => void
	enableSelfMedia: () => void
	sendBlip: (text?: string) => void
	sendFiles: (files: File[]) => void
	setBlipText: (text: string) => void
	setInviteText: (inviteText: string) => void
	setReplyText: (replyText: string) => void
	toggleCamera: () => void
	toggleMicrophone: () => void
	toggleScreen: () => void
}

const sendPacket = (peer: Peer, packet: Packet) => {
	// Keep packets typed until the last inch before the data channel.
	return peer.send(encodePacket(packet))
}

const linkLog = (link: RoomLink) => {
	// Logs need identities and roles, not raw SDP or file payloads.
	return {
		auth: link.auth,
		id: link.id,
		remoteId:
			link.remoteId == null ? null : participantIdToString(link.remoteId),
		role: link.role,
		source: link.source,
		beaconPeerId: link.beaconPeerId,
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

const BEACON_CANDIDATE_LIMIT = 12
const BEACON_CANDIDATE_TTL_MS = 45_000

export const createRoom = () => {
	// Three ledgers keep the room understandable:
	// participants are roster order plus visible activity;
	// links are mutable transports that may or may not be people yet;
	// state.connection is only the invite/reply card the UI shows.
	// Incoming bytes live off-store until complete; the store carries only progress.
	const incomingFiles = new Map<string, IncomingFileTransfer>()
	// Object URLs are browser resources. Keep every one we mint so cleanup is exact.
	let fileUrls = new Set<string>()
	// Guests can write a blip before the host gives them a participant id.
	let pendingLocalBlip: string | null = null
	// Host identity is the closest thing we have to room identity, so it also paints the room.
	let localParticipantId: ParticipantId | null = randomParticipantId()
	// Guests learn this from welcome. Hosts start as their own host.
	let hostParticipantId: ParticipantId | null = localParticipantId
	// The secret backs beacon discovery; manual codes do not need it.
	let roomSecret: RoomSecret | null = null
	// Derived keys prove beacon peers actually know the invite link.
	let roomKeys: RoomKeys | null = null
	// Beacon rendezvous is a helper, not the room. It can come and go.
	let beaconRendezvous: BeaconRendezvous | null = null
	// Every new signaling attempt invalidates older async work.
	let signalingVersion = 0
	// Links need stable ids before they know who is on the other side.
	let linkSequence = 0
	// Camera permission can race with teardown; versioning keeps late streams out.
	let selfMediaVersion = 0
	let screenTrackEndCleanup: (() => void) | null = null
	// Beacon answers come back by offer id, before a person is known.
	const beaconOffers = new Map<string, RoomLink>()
	const hostParticipant = mergeParticipant({ id: localParticipantId })
	// Links are transport state. Solid sees them through linkRevision.
	const links = new Map<LinkId, RoomLink>()
	const [linkRevision, setLinkRevision] = createSignal(0)
	// Keep roster order explicit so cards do not reshuffle from object keys.
	const [participantKeys, setParticipantKeys] = createSignal<ParticipantKey[]>([
		hostParticipant.id,
	])
	// Null local key means "guest has not been welcomed yet."
	const [localKey, setLocalKey] = createSignal<ParticipantKey | null>(
		hostParticipant.id,
	)
	// Participant records hold identity plus visible activity.
	const [participants, setParticipants] = createStore<
		Partial<Record<ParticipantKey, RoomParticipant>>
	>({
		[hostParticipant.id]: hostParticipant,
	})

	const [state, setState] = createStore(emptyRoomState(hostParticipant.id))

	const peerKeys = createMemo(() => {
		// The self portrait is special; everyone else is a peer card.
		const local = localKey()
		return participantKeys().filter((key) => key !== local)
	})

	const participantByKey = (key: ParticipantKey) => {
		return participants[key] ?? null
	}

	const selfActivity = createMemo(() => {
		// Before welcome, pendingLocalBlip is the only self activity we have.
		const key = localKey()
		return key == null
			? emptyParticipantActivity()
			: (participantByKey(key)?.activity ?? emptyParticipantActivity())
	})

	const isSelfHost = () => {
		// Hostness is identity, not which card is currently visible.
		return (
			localParticipantId != null && localParticipantId === hostParticipantId
		)
	}

	const isSelfGuest = () => {
		// A welcomed guest has both ids, and they differ.
		return (
			localParticipantId != null &&
			hostParticipantId != null &&
			localParticipantId !== hostParticipantId
		)
	}

	const touchLinks = () => {
		// Links are mutable on purpose; this is the one Solid wake-up bell.
		setLinkRevision((revision) => revision + 1)
	}

	const peerByKey = (key: ParticipantKey): RoomPeer | null => {
		const participant = participantByKey(key)
		if (participant == null) return null

		// Link state decides whether a person is live; participant state decides what they showed.
		linkRevision()
		const link = linkByParticipantKey(key)
		return {
			activity: participant.activity,
			id: participant.id,
			mediaState: link?.mediaState ?? null,
			mediaStream: link?.mediaStream ?? null,
			connectionState: link?.live ? 'live' : 'waiting',
		}
	}

	const peers = createMemo(() => {
		return peerKeys().flatMap((key) => {
			const peer = peerByKey(key)
			return peer == null ? [] : [peer]
		})
	})

	const participantById = (participantId: ParticipantId | null) => {
		return participantId == null
			? null
			: participantByKey(participantKey(participantId))
	}

	const nextLinkId = (role: LinkRole): LinkId => {
		// Roles make debugging readable before a remote participant exists.
		linkSequence++
		return `${role}:${linkSequence}`
	}

	const currentRendezvousLink = (role?: LinkRole, source?: LinkSource) => {
		// There should be at most one open invite lane for a given path.
		return findRendezvousLink(links.values(), role, source)
	}

	const linkByParticipantKey = (key: ParticipantKey) => {
		return findParticipantLink(links.values(), key)
	}

	const linkedPeers = () => {
		return [...links.values()].map((link) => link.peer)
	}

	const removeLink = (link: RoomLink) => {
		// Remove means "stop routing"; closeLink adds browser teardown.
		if (links.get(link.id) !== link) return

		link.live = false
		links.delete(link.id)
		for (const [offerId, offerLink] of beaconOffers) {
			if (offerLink === link) beaconOffers.delete(offerId)
		}
		touchLinks()
	}

	const closeLink = (link: RoomLink) => {
		// Close from our side should still clean room bookkeeping first.
		removeLink(link)

		try {
			link.peer.close()
		} catch {}
	}

	const closeRendezvousLink = (role?: LinkRole, source?: LinkSource) => {
		// Replacing an invite should not disturb established mesh links.
		const link = currentRendezvousLink(role, source)
		if (link != null) closeLink(link)
	}

	const closeAllLinks = () => {
		// Snapshot first; close callbacks may try to mutate the same map.
		const closingLinks = [...links.values()]
		links.clear()
		beaconOffers.clear()
		for (const link of closingLinks) link.live = false
		touchLinks()

		for (const link of closingLinks) {
			try {
				link.peer.close()
			} catch {}
		}
	}

	const stopBeaconRendezvous = () => {
		// Beacon candidates are meaningless once the beacon loop stops.
		beaconRendezvous?.close()
		beaconRendezvous = null
		beaconOffers.clear()
	}

	const participantLink = (participantId: ParticipantId) => {
		// Most protocol packets name participants, not link ids.
		return linkByParticipantKey(participantKey(participantId))
	}

	const adoptLink = (link: RoomLink, participantId: ParticipantId) => {
		// Adoption needs a participant record first, then enforces one link per person.
		if (links.get(link.id) !== link) return false
		if (link.remoteId != null && link.remoteId !== participantId) return false

		const key = participantKey(participantId)
		const person = participants[key]
		if (person == null) return false

		const existing = linkByParticipantKey(key)
		if (existing != null && existing !== link) closeLink(existing)

		link.remoteId = participantId
		for (const [offerId, offerLink] of beaconOffers) {
			if (offerLink === link) beaconOffers.delete(offerId)
		}
		touchLinks()
		return true
	}

	const closeSiblingRendezvousLinks = (link: RoomLink) => {
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

			closeLink(candidate)
		}
	}

	const isBeaconCandidate = (link: RoomLink, role?: LinkRole) => {
		// Beacon flow starts with anonymous WebRTC links; auth and welcome promote one.
		return (
			link.source === 'beacon' &&
			link.remoteId == null &&
			(role == null || link.role === role)
		)
	}

	const beaconCandidates = (role: LinkRole) => {
		// Candidate order is insertion order; oldest loses when the budget is full.
		return [...links.values()].filter((link) => isBeaconCandidate(link, role))
	}

	const candidateBudgetAllows = (role: LinkRole) => {
		return beaconCandidates(role).length < BEACON_CANDIDATE_LIMIT
	}

	const expireBeaconCandidate = (link: RoomLink, reason: string) => {
		// Dead candidates should disappear quietly from the portrait projection.
		if (links.get(link.id) !== link) return
		if (!isBeaconCandidate(link)) return

		infoRoom('beacon.candidate.expired', {
			link: linkLog(link),
			reason,
		})
		closeLink(link)
	}

	const pruneBeaconCandidateBudget = (role: LinkRole) => {
		while (!candidateBudgetAllows(role)) {
			const oldest = beaconCandidates(role)[0]
			if (oldest == null) return

			expireBeaconCandidate(oldest, 'budget')
		}
	}

	const createBeaconCandidate = (
		role: LinkRole,
		options: { offerId?: string | null; beaconPeerId?: string | null } = {},
	) => {
		// Beacon offers are speculative. Keep only a small bench of hopeful links.
		pruneBeaconCandidateBudget(role)
		if (!candidateBudgetAllows(role)) {
			warnRoom('beacon.candidate.budget-full', { role })
			return null
		}

		const link = createLink(role, {
			source: 'beacon',
			beaconPeerId: options.beaconPeerId ?? null,
		})
		if (options.offerId != null) beaconOffers.set(options.offerId, link)

		setTimeout(() => {
			expireBeaconCandidate(link, 'timeout')
		}, BEACON_CANDIDATE_TTL_MS)
		return link
	}

	const promoteRendezvousLink = (
		link: RoomLink,
		participantId: ParticipantId,
	) => {
		// Beacon discovery earns a room seat only after auth proves the secret.
		if (link.source === 'beacon' && link.auth !== 'verified') {
			warnRoom('beacon.candidate.promote.before-auth', {
				link: linkLog(link),
				participantId: participantIdToString(participantId),
			})
			closeLink(link)
			return false
		}

		if (!adoptLink(link, participantId)) return false

		closeSiblingRendezvousLinks(link)
		return true
	}

	const verifiedBeaconLinkByPeer = (
		role: LinkRole,
		beaconPeerId: string,
		except: RoomLink | null = null,
	) => {
		// One verified beacon link per beacon peer is enough.
		for (const link of links.values()) {
			if (link === except) continue
			if (link.role !== role) continue
			if (link.source !== 'beacon') continue
			if (link.beaconPeerId !== beaconPeerId) continue
			if (link.auth === 'verified') return link
		}

		return null
	}

	const replaceParticipants = (roster: Participant[]) => {
		// The host owns membership; guests keep local activity while matching it.
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
		// Remove the card first; callers may still close the old peer afterward.
		const key = participantKey(participantId)
		const link = participantLink(participantId)

		if (link != null) removeLink(link)
		setParticipantKeys((keys) => keys.filter((item) => item !== key))
		setParticipants(key, undefined)

		return link
	}

	const allocateParticipantId = () => {
		// The host hands guests ids so all peers agree on the same roster.
		while (true) {
			const id = randomParticipantId()
			if (id === localParticipantId) continue
			if (id === hostParticipantId) continue
			if (participants[participantKey(id)] != null) continue

			return id
		}
	}

	const resetAsHost = () => {
		// Starting fresh as host makes a new room identity and color.
		stopBeaconRendezvous()
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

	const resetBeforeJoining = (options: { keepPendingBlip?: boolean } = {}) => {
		// Before welcome, a guest has no durable identity in this room.
		stopBeaconRendezvous()
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
		// Send only protocol identity; activity moves as live packets.
		return participantKeys()
			.map((key) => participants[key])
			.filter((person): person is RoomParticipant => person != null)
			.map(rosterParticipant)
	}

	const liveParticipantLinkCount = () => {
		return liveParticipantLinks().length
	}

	const sendToParticipant = (participantId: ParticipantId, packet: Packet) => {
		// Missing links are normal while the mesh is still forming.
		const link = participantLink(participantId)
		if (link == null || !link.live) return false

		return sendPacket(link.peer, packet)
	}

	const sendToLinks = (targetLinks: RoomLink[], packet: Packet) => {
		// Return a count so file sends can fail fast when everyone disappears.
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
		// Broadcast follows the roster order and skips the optional sender.
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
		// Common packets go only to people, not invite candidates.
		return liveIdentifiedLinks(links.values())
	}

	const selfMediaState = (
		media: SelfMedia = state.selfMedia,
	): PeerMediaState => {
		// Peers care about what we are actually sending, not permission details.
		return {
			cameraEnabled:
				media.status === 'live' && media.cameraAvailable && media.cameraEnabled,
			microphoneEnabled:
				media.status === 'live' &&
				media.microphoneAvailable &&
				media.microphoneEnabled,
			screenEnabled:
				media.status === 'live' &&
				media.screenEnabled &&
				media.screenStream != null,
		}
	}

	const setPeerMediaState = (
		participantId: ParticipantId,
		mediaState: PeerMediaState,
	) => {
		// Remote media state decorates the link because it is transport-adjacent.
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
		// Welcome gives the pending blip a real owner.
		if (localParticipantId == null || pendingLocalBlip == null) return

		setParticipantBlip(localParticipantId, pendingLocalBlip)
		pendingLocalBlip = null
	}

	const sendLocalBlipToPeer = (peer: Peer) => {
		// New links should see the current blip without waiting for the next edit.
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
		// After auth, normal room packets may pass on this candidate.
		link.auth = 'verified'
		link.authNonce = null
		touchLinks()
	}

	const sendBeaconChallenge = (link: RoomLink) => {
		// The host makes beacon candidates prove they know the room secret.
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

	const answerBeaconChallenge = async (link: RoomLink, nonce: string) => {
		// The guest signs the nonce; no room identity is revealed yet.
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

	const acceptBeaconResponse = async (link: RoomLink, mac: string) => {
		// A valid MAC tells apart the public beacon noise from a trusted candidate with the link on hands.
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
		// Auth packets are consumed before room-role dispatch.
		switch (message.type) {
			case 'auth-challenge':
				if (link.source !== 'beacon' || link.role !== 'guest-rendezvous') {
					warnRoom('auth.challenge.unexpected', { link: linkLog(link) })
					return true
				}

				void answerBeaconChallenge(link, message.nonce)
				return true
			case 'auth-accepted':
				if (link.source !== 'beacon' || link.role !== 'guest-rendezvous') {
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
				if (link.source !== 'beacon' || link.role !== 'host-rendezvous') {
					warnRoom('auth.response.unexpected', { link: linkLog(link) })
					return true
				}

				void acceptBeaconResponse(link, message.mac)
				return true
			default:
				return false
		}
	}

	const publishLocalBlip = () => {
		// Replay the current blip to newly welcomed peers; edits send their own packet.
		const blip = localBlip()
		if (blip == null) return 0

		return sendToLinks(liveParticipantLinks(), { type: 'blip', text: blip })
	}

	const publishLocalMediaState = (mediaState = selfMediaState()) => {
		// When camera state changes, every live portrait should update.
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
		nextFile: PortraitFileState,
	) => {
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

	const markLocalSendingFilesError = () => {
		// One failed drop marks any in-flight local chips as failed.
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
		// Download links are cheap to show but not free to keep.
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
		// Start creates both the byte bucket and the visible receiving chip.
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
		// Chunks can outlive their sender; unknown ids are just stale packets.
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
		// Only at the end do bytes become a downloadable browser URL.
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
					screenEnabled: message.screenEnabled,
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
		// When a room ends, keep only the self card's history.
		const local = localKey()
		const self = local == null ? null : participants[local]

		setParticipants(
			reconcile(local != null && self != null ? { [local]: self } : {}),
		)
		setParticipantKeys(local == null ? [] : [local])
	}

	const markRoomClosed = () => {
		// Closed is visible state plus real transport teardown.
		stopBeaconRendezvous()
		closeAllLinks()
		clearPeerParticipants()
		setState('connection', closedConnection())
	}

	const removeParticipantLink = (
		participantId: ParticipantId,
		options: { peer?: Peer | null } = {},
	) => {
		// Link loss can mean "one guest left" or "the whole room ended."
		const key = participantKey(participantId)
		const link = participantLink(participantId)
		if (link == null) return
		if (options.peer != null && link.peer !== options.peer) return

		removeLink(link)

		if (isSelfGuest() && participantId === hostParticipantId) {
			markRoomClosed()
			return
		}

		// Guests can come and go. A guest only loses the room when the host disappears.
		if (isSelfHost()) {
			setParticipantKeys((keys) => keys.filter((item) => item !== key))
			setParticipants(key, undefined)
			broadcastMembershipChange({ left: participantId })

			if (
				liveParticipantLinkCount() === 0 &&
				currentRendezvousLink('host-rendezvous', 'manual') == null
			) {
				void startInviteAsHost({ resetPeers: false })
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
			beaconPeerId?: string | null
		} = {},
	) => {
		// Create the transport first; the room role decides what it becomes.
		const source = options.source ?? 'manual'
		const id = nextLinkId(role)
		const peer = createPeer({
			onOpen: () => handleLinkOpen(id),
			onMessage: (text) => handleLinkMessage(id, text),
			onRemoteMedia: (stream) => {
				// Remote media belongs to the link, because the participant may reconnect.
				const link = links.get(id)
				if (link == null) return

				link.mediaStream = stream
				touchLinks()
			},
			onState: (state) => {
				// Beacon links are the hard part; log their RTC state while they settle.
				const link = links.get(id)
				if (link == null || link.source !== 'beacon') return

				infoRoom('rtc.state', { link: linkLog(link), ...state })
			},
			onClose: () => handleLinkClose(id),
		})

		const link: RoomLink = {
			auth: options.auth ?? (source === 'beacon' ? 'pending' : 'verified'),
			authNonce: null,
			id,
			live: false,
			mediaState: null,
			mediaStream: null,
			peer,
			remoteId: options.remoteId ?? null,
			role,
			source,
			beaconPeerId: options.beaconPeerId ?? null,
		}
		links.set(id, link)
		touchLinks()
		// New links should inherit any already-enabled camera/mic immediately.
		peer.setLocalMedia(state.selfMedia.stream)
		return link
	}

	const handleLinkOpen = (linkId: LinkId) => {
		// Open transport is not always room membership; beacon auth may still be pending.
		const link = links.get(linkId)
		if (link == null) return

		link.live = true
		touchLinks()
		infoRoom('link.open', { link: linkLog(link) })

		if (link.source === 'beacon' && link.auth !== 'verified') {
			if (link.role === 'host-rendezvous') sendBeaconChallenge(link)
			else if (link.role !== 'guest-rendezvous') {
				errorRoom('auth.unexpected-beacon-link-role', { link: linkLog(link) })
				closeLink(link)
			}
			return
		}

		if (link.role === 'guest-rendezvous') {
			// Guests say hello first; hosts answer with welcome and identity.
			sendPacket(link.peer, { type: 'hello' })
			return
		}

		if (link.remoteId != null) {
			// Reconnected or mesh links should receive the current self presence.
			sendLocalBlipToPeer(link.peer)
			sendLocalMediaStateToPeer(link.peer)
		}
	}

	const handleLinkClose = (linkId: LinkId) => {
		// Close callbacks arrive after many paths; look up the current link before acting.
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
			isSelfHost()
		) {
			// A closed manual host invite should be replaced so the host stays joinable.
			void startInviteAsHost({ resetPeers: false })
		} else if (
			link.role === 'guest-rendezvous' &&
			link.source === 'beacon' &&
			localParticipantId == null
		) {
			return
		} else if (link.role === 'guest-rendezvous') {
			// Losing the host rendezvous before membership means the guest is done here.
			markRoomClosed()
		}
	}

	const handleLinkMessage = (linkId: LinkId, text: string) => {
		// Every incoming string becomes either auth, setup, or common room activity.
		const link = links.get(linkId)
		if (link == null) return

		const message = decodePacket(text)
		if (message == null) {
			warnRoom('packet.decode.failed', { length: text.length, linkId })
			return
		}
		if (handleAuthPacket(link, message)) return
		if (link.source === 'beacon' && link.auth !== 'verified') {
			// Beacon-discovered transports are only candidates until they prove the room secret.
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
		// Mesh packets are only meaningful after the link is tied to a participant.
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
		// Mesh links skip rendezvous; the roster already names the target.
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

	// Mesh flow: the host shares the roster and forwards offers/answers;
	// guests use a deterministic tie-break so exactly one side dials each edge.
	const createMeshOffer = async (participantId: ParticipantId) => {
		if (
			!isSelfGuest() ||
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
		// After each roster update, fill in direct guest-to-guest edges.
		if (
			!isSelfGuest() ||
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
		// The target guest answers, then the host carries that answer back.
		if (!isSelfGuest() || localParticipantId == null) {
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
		// The dialing guest completes the direct edge here.
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
		// If the host is gone from the roster, the room is gone for guests.
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
		// Roster leaves are host-approved; close any direct link we had.
		if (participantId === hostParticipantId) {
			markRoomClosed()
			return
		}

		deleteParticipant(participantId)?.peer.close()
	}

	const handleGuestMessage = (link: RoomLink, message: Packet) => {
		// Before welcome, the rendezvous link itself is the best sender hint.
		const senderId = hostParticipantId ?? link.remoteId
		if (senderId != null && handleCommonMessage(senderId, message)) return

		switch (message.type) {
			case 'welcome':
				// Welcome is the handoff from paste-code UX into actual room membership.
				localParticipantId = message.selfId
				hostParticipantId = message.hostId
				stopBeaconRendezvous()
				setState('themeSeed', participantIdToString(message.hostId))
				setLocalKey(participantKey(message.selfId))
				replaceParticipants(message.roster)
				applyPendingLocalBlip()
				if (!promoteRendezvousLink(link, message.hostId)) {
					errorRoom('guest.welcome.adopt-link.failed', {
						hostId: participantIdToString(message.hostId),
						link: linkLog(link),
					})
					markRoomClosed()
					return
				}
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
		// Welcome gives the guest its id, host id, and first full roster.
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
		// Hosts accept room activity and broker mesh setup.
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
		// The first hello on a host rendezvous claims a participant slot.
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
		if (!promoteRendezvousLink(link, participant.id)) {
			errorRoom('host.admit.adopt-link.failed', {
				link: linkLog(link),
				participantId: participantIdToString(participant.id),
			})
			deleteParticipant(participant.id)
			return null
		}

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
		// Host rendezvous packets may be pre-admission or normal guest packets.
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
			void startInviteAsHost({ resetPeers: false })
		}
	}

	const setHostAutoStatus = (status: BeaconStatus) => {
		// Beacon status is only visible on the host invite link pane.
		if (state.connection.side !== 'host') return

		setState('connection', {
			...state.connection,
			inviteLinkStatus: status,
		})
	}

	const beaconRendezvousRole = (): LinkRole | null => {
		// The beacon path mirrors the manual host/guest doorway.
		if (isSelfHost()) return 'host-rendezvous'
		if (usesGuestRendezvous()) return 'guest-rendezvous'

		return null
	}

	const createBeaconOffer = async (
		offerId: string,
		beaconPeerId: string | null,
	) => {
		// Beacon offers are speculative; they may never become room members.
		const role = beaconRendezvousRole()
		if (role == null) return null

		const link = createBeaconCandidate(role, { beaconPeerId, offerId })
		if (link == null) return null

		try {
			const offer = await link.peer.createOffer()
			if (beaconOffers.get(offerId) !== link) {
				closeLink(link)
				return null
			}

			return offer
		} catch (error) {
			warnRoom('beacon.offer.create.failed', {
				error,
				link: linkLog(link),
				offerId,
			})
			closeLink(link)
			return null
		}
	}

	const acceptBeaconAnswer = (
		offerId: string,
		beaconPeerId: string,
		answer: SignalDescription,
	) => {
		// An answer names the beacon peer that responded to our speculative offer.
		const link = beaconOffers.get(offerId)
		if (link == null) {
			warnRoom('beacon.answer.missing-offer', { offerId })
			return
		}

		const existing = verifiedBeaconLinkByPeer(link.role, beaconPeerId, link)
		if (existing != null) {
			infoRoom('beacon.answer.ignored.verified-peer', {
				existing: linkLog(existing),
				link: linkLog(link),
			})
			closeLink(link)
			return
		}

		link.beaconPeerId = beaconPeerId
		touchLinks()
		infoRoom('beacon.answer.accept.start', { link: linkLog(link) })
		void link.peer
			.acceptAnswer(answer)
			.then(() => {
				if (links.get(link.id) !== link) return

				infoRoom('beacon.answer.accept.done', { link: linkLog(link) })
			})
			.catch((error) => {
				warnRoom('beacon.answer.accept.failed', {
					error,
					link: linkLog(link),
					offerId,
				})
				closeLink(link)
			})
	}

	const answerBeaconOffer = (
		offer: SignalDescription,
		beaconPeerId: string,
		reply: (answer: SignalDescription) => void,
	) => {
		// A beacon offer is worth answering only while we know this room secret.
		const role = beaconRendezvousRole()
		if (roomKeys == null || role == null) {
			warnRoom('beacon.offer.unexpected', {
				hasRoomKeys: roomKeys != null,
				role,
			})
			return
		}
		const existing = verifiedBeaconLinkByPeer(role, beaconPeerId)
		if (existing != null) {
			infoRoom('beacon.offer.ignored.verified-peer', {
				existing: linkLog(existing),
				role,
			})
			return
		}

		const link = createBeaconCandidate(role, { beaconPeerId })
		if (link == null) return

		void link.peer
			.createAnswer(offer)
			.then((answer) => {
				if (links.get(link.id) !== link) return

				infoRoom('beacon.offer.answer.sent', { link: linkLog(link) })
				reply(answer)
			})
			.catch((error) => {
				warnRoom('beacon.offer.answer.failed', {
					error,
					link: linkLog(link),
				})
				closeLink(link)
			})
	}

	const usesGuestRendezvous = () => {
		// Invite-link guests start identity-less, then become normal guests on welcome.
		return localParticipantId == null || isSelfGuest()
	}

	const startBeaconRendezvous = async (
		secret: RoomSecret,
		role: 'guest' | 'host',
		version: number,
	) => {
		// The invite link becomes discovery plus auth; beacons never see room contents.
		try {
			const keys = await deriveRoomKeys(secret)
			if (version !== signalingVersion || roomSecret !== secret) return

			roomKeys = keys
			beaconRendezvous?.close()
			if (role === 'host') {
				for (const link of new Set(beaconOffers.values())) closeLink(link)
				beaconOffers.clear()
			}
			beaconRendezvous = createBeaconRendezvous({
				createOffer: createBeaconOffer,
				discoveryId: keys.discoveryId,
				onAnswer: acceptBeaconAnswer,
				onOffer: answerBeaconOffer,
				onStatus: (status) => {
					// Ignore old beacon loops after a new invite/reply attempt starts.
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
								'This invite link did not find the host yet. Ask for an invite code if it keeps waiting.',
						})
					}
				},
				role,
			})
		} catch (error) {
			warnRoom('beacon.start.failed', { error, role })
			if (role === 'host') setHostAutoStatus('failed')
			else if (state.connection.side === 'guest') {
				setState('connection', {
					...state.connection,
					issue:
						'This invite link could not start here. Ask for an invite code instead.',
				})
			}
		}
	}

	const joinRoomWithInviteLink = (secret: RoomSecret) => {
		// Opening an invite link makes the guest wait for the host, no reply code needed.
		const version = ++signalingVersion
		resetBeforeJoining({ keepPendingBlip: true })
		roomSecret = secret
		setState('connection', {
			...emptyGuestConnection(),
			status: 'finding-link',
			inviteText: inviteLinkFromSecret(secret),
		})
		void startBeaconRendezvous(secret, 'guest', version)
	}

	const startInviteAsHost = async (
		options: { resetPeers: boolean } = { resetPeers: true },
	) => {
		// Invite flow: every host room prepares the link path and the code path.
		// The link path uses beacon discovery; the code path is one manual offer.
		const version = ++signalingVersion
		let nextLink: RoomLink | null = null

		try {
			if (options.resetPeers) {
				// A full host restart means a new room, not a new invite for old peers.
				resetAsHost()
				setState('blipComposer', emptyBlipComposer())
			} else if (localParticipantId == null || hostParticipantId == null) {
				resetAsHost()
			} else {
				closeRendezvousLink('host-rendezvous', 'manual')
			}

			if (roomSecret == null) roomSecret = randomRoomSecret()
			// One secret powers all invite link attempts for this host room.
			const secret = roomSecret
			const inviteLink = inviteLinkFromSecret(secret)
			setState('connection', {
				...emptyHostConnection(),
				inviteLink,
				inviteLinkStatus: 'finding',
			})
			void startBeaconRendezvous(secret, 'host', version)

			nextLink = createLink('host-rendezvous', { source: 'manual' })
			// The invite code is a one-shot offer waiting for one guest reply.
			const offer = await nextLink.peer.createOffer()
			const inviteSignal = await encodeSignal(offer)
			if (
				version !== signalingVersion ||
				currentRendezvousLink('host-rendezvous', 'manual') !== nextLink
			) {
				closeLink(nextLink)
				return
			}

			const inviteCode = inviteCodeFromSignal(inviteSignal)
			setState('connection', {
				...emptyHostConnection(),
				inviteLink,
				inviteLinkStatus:
					state.connection.side === 'host'
						? state.connection.inviteLinkStatus
						: 'finding',
				status: 'invite-ready',
				inviteCode,
			})
		} catch (error) {
			warnRoom('invite.create.failed', { error })
			if (nextLink != null) closeLink(nextLink)
			if (version !== signalingVersion) return
			setState('connection', {
				...(state.connection.side === 'host'
					? state.connection
					: emptyHostConnection()),
				issue: 'Could not create an invite link or invite code.',
			})
		}
	}

	const becomeGuest = () => {
		// Switching sides abandons host identity and any old invites.
		signalingVersion++
		resetBeforeJoining()
		setState('connection', emptyGuestConnection())
		setState('blipComposer', emptyBlipComposer())
	}

	const createReply = async (inviteText?: string) => {
		// Guest paste decides the path: invite link or manual answer code.
		const inviteInput = (
			inviteText ??
			(state.connection.side === 'guest' ? state.connection.inviteText : '')
		).trim()
		const invite = inviteFromInput(inviteInput)
		if (invite.type === 'empty') return
		if (invite.type === 'invite-link') {
			joinRoomWithInviteLink(invite.secret)
			return
		}

		const version = ++signalingVersion
		let nextLink: RoomLink | null = null

		try {
			resetBeforeJoining({ keepPendingBlip: true })
			setState('connection', {
				...emptyGuestConnection(),
				status: 'creating-reply',
				inviteText: inviteInput,
			})

			nextLink = createLink('guest-rendezvous', { source: 'manual' })
			// Manual reply turns the host's offer into an answer they can paste back.
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
				issue:
					'That invite did not work. Paste a fresh invite link or code and try again.',
			})
		}
	}

	const acceptReply = async (replyText?: string) => {
		// The host finishes the manual handshake by accepting the guest answer.
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
						'That reply code did not work. Ask for a fresh reply code or create a new invite.',
				})
			}
		}
	}

	const sendBlip = (text = state.blipComposer.text) => {
		// Blips are tiny presence, so we store locally and fan out immediately.
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

	const publishSelfMediaSnapshot = (selfMedia: SelfMedia) => {
		setState('selfMedia', selfMedia)
		publishSelfMedia(selfMedia.stream)
		publishLocalMediaState(selfMediaState(selfMedia))
	}

	const clearScreenTrackEndListener = () => {
		screenTrackEndCleanup?.()
		screenTrackEndCleanup = null
	}

	const stopScreenShare = (
		options: { stopTracks?: boolean } = { stopTracks: true },
	) => {
		const screenStream = state.selfMedia.screenStream
		clearScreenTrackEndListener()
		if (options.stopTracks ?? true) stopMediaStream(screenStream)

		const selfMedia = withActiveSelfMediaStream({
			...state.selfMedia,
			screenEnabled: false,
			screenRequesting: false,
			screenStream: null,
		})
		publishSelfMediaSnapshot(selfMedia)
	}

	const watchScreenMediaEnd = (screenStream: MediaStream, version: number) => {
		clearScreenTrackEndListener()
		const track = screenStream.getVideoTracks()[0] ?? null
		if (track == null) return

		const handleEnd = () => {
			if (
				version !== selfMediaVersion ||
				state.selfMedia.screenStream !== screenStream
			) {
				return
			}

			stopScreenShare({ stopTracks: false })
		}

		track.addEventListener('ended', handleEnd)
		screenTrackEndCleanup = () => track.removeEventListener('ended', handleEnd)
		if (track.readyState === 'ended') handleEnd()
	}

	const sendFileToPeers = async (file: File, peers: RoomLink[]) => {
		// File flow: choose recipients at drop time, then show local progress from bytes sent.
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
		// Drops without peers become composer feedback, not hidden work.
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
		// Media flow: local SelfMedia drives tracks on every link plus media-state packets.
		selfMediaVersion++
		clearScreenTrackEndListener()
		publishSelfMedia(null)
		stopSelfMedia(state.selfMedia)
		const selfMedia = emptySelfMedia()
		publishSelfMediaSnapshot(selfMedia)
	}

	const enableSelfMedia = async () => {
		if (state.selfMedia.status === 'requesting') return

		// Camera permission belongs to the self portrait, not to page load.
		const version = ++selfMediaVersion
		clearScreenTrackEndListener()
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

		publishSelfMediaSnapshot(selfMedia)
	}

	const setTracksEnabled = (kind: 'audio' | 'video', enabled: boolean) => {
		// Toggling a track changes both local hardware state and remote affordances.
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

	const startScreenShare = async () => {
		if (
			state.selfMedia.status !== 'live' ||
			!state.selfMedia.screenAvailable ||
			state.selfMedia.screenRequesting
		) {
			return
		}

		const version = selfMediaVersion
		setState('selfMedia', 'screenRequesting', true)

		let screenStream: MediaStream
		try {
			screenStream = await captureScreenMedia()
		} catch {
			if (version === selfMediaVersion) {
				setState('selfMedia', 'screenRequesting', false)
			}
			return
		}

		if (version !== selfMediaVersion || state.selfMedia.status !== 'live') {
			stopMediaStream(screenStream)
			return
		}

		clearScreenTrackEndListener()
		stopMediaStream(state.selfMedia.screenStream)
		const selfMedia = withActiveSelfMediaStream({
			...state.selfMedia,
			issue: null,
			screenEnabled: true,
			screenRequesting: false,
			screenStream,
		})
		publishSelfMediaSnapshot(selfMedia)
		watchScreenMediaEnd(screenStream, version)
	}

	const toggleScreen = () => {
		if (state.selfMedia.screenRequesting) return
		if (state.selfMedia.screenEnabled) {
			stopScreenShare()
			return
		}

		void startScreenShare()
	}

	onMount(() => {
		// URL hash wins on load; otherwise this browser starts as host.
		const invite = readInviteFromHash()

		if (invite.type === 'invite-link') {
			joinRoomWithInviteLink(invite.secret)
			return
		}

		if (invite.type === 'manual-code') {
			void createReply(invite.code)
			return
		}

		void startInviteAsHost()
	})

	onCleanup(() => {
		// Tear down browser resources in the opposite order people see them.
		stopBeaconRendezvous()
		closeAllLinks()
		disposeFileUrls()
		disposeSelfMedia()
	})

	const actions: RoomActions = {
		// Keep UI callbacks synchronous-looking even when the room work is async.
		becomeGuest,
		becomeHost: () => {
			void startInviteAsHost()
		},
		copyInviteLink: () =>
			void copyText(
				state.connection.side === 'host' ? state.connection.inviteLink : '',
			),
		copyInviteCode: () =>
			void copyText(
				state.connection.side === 'host' ? state.connection.inviteCode : '',
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
		toggleScreen,
	}

	return {
		actions,
		state,
		peers,
		selfActivity,
	}
}

export type RoomHandle = ReturnType<typeof createRoom>
export type { RoomState } from './room/initial-state'
