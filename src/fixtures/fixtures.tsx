import type { JSX } from 'solid-js'
import { parseSignalExchangeId } from '../../contracts/signal'
import { parseParticipantId } from '../protocol'
import type {
	GuestJoinState,
	HostInviteState,
	RoomEntryState,
} from '../room/entry/state'
import type { RoomConnection } from '../room/link'
import type { SelfMedia } from '../room/media'
import type { RoomPeer, SharedFile } from '../room/participant'
import type { RelayMetering } from '../room/relay'
import { RoomView, type RoomViewProps } from '../ui/room-view'
import type { RtcPeer } from '../webrtc'

type UiFixture = {
	id: string
	title: string
	render: () => JSX.Element
}

const SAMPLE_OFFER =
	'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=flop\nt=0 0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel'
const SAMPLE_INVITE_CODE = `https://flop.local/#${encodeURIComponent(SAMPLE_OFFER)}`
const SAMPLE_INVITE_LINK = 'https://flop.local/#ybybybybybybybybybybybybyb'
const SAMPLE_REPLY =
	'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=flop-reply\nt=0 0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel'
const fixtureParticipantId = (value: string) => {
	const id = parseParticipantId(value)
	if (id == null) throw new Error(`Invalid fixture participant id: ${value}`)
	return id
}

const HOST_ID = fixtureParticipantId('48b6a1e2c59d730f')
const OLEG_ID = fixtureParticipantId('79df2a4c038be116')
const NADIA_ID = fixtureParticipantId('b05e9d8328aa41c7')
const MESH_EXCHANGE_ID = parseSignalExchangeId('fixture-mesh-id-0001')
if (MESH_EXCHANGE_ID == null)
	throw new Error('Invalid fixture mesh exchange id')

const noop = () => {}

const fixtureCommands: RoomViewProps['room']['commands'] = {
	acceptReplyCode: noop,
	becomeGuest: noop,
	becomeHost: noop,
	claimInviteLinkAsHost: noop,
	joinInvite: noop,
	dismissFileTransferIssue: noop,
	enableSelfMedia: noop,
	sendBlip: noop,
	sendFiles: noop,
	setBlipDraft: noop,
	setInviteText: noop,
	setReplyText: noop,
	toggleCamera: noop,
	toggleMicrophone: noop,
	toggleScreen: noop,
	tryRelay: noop,
}

const noFiles: SharedFile[] = []
const unavailableRtcOperation = async () => {
	throw new Error('Room fixtures do not execute WebRTC operations')
}

const fixtureRtc: RtcPeer = {
	acceptAnswer: unavailableRtcOperation,
	close: noop,
	createAnswer: unavailableRtcOperation,
	createOffer: unavailableRtcOperation,
	relayBytes: async () => null,
	setLocalMedia: noop,
	trySend: () => false,
	waitForBufferBelow: async () => {},
}

const fixturePeer = (
	id: RoomPeer['id'],
	options: {
		blip?: string | null
		connected?: boolean
		files?: SharedFile[]
		mediaPresence?: RoomConnection['mediaPresence']
		mediaStream?: MediaStream | null
	} = {},
): RoomPeer => {
	const connection: RoomConnection | null = options.connected
		? {
				connected: true,
				mediaPresence: options.mediaPresence ?? null,
				mediaStream: options.mediaStream ?? null,
				origin: { exchangeId: MESH_EXCHANGE_ID, kind: 'mesh' },
				rtc: fixtureRtc,
			}
		: null

	return {
		blip: options.blip ?? null,
		connection,
		files: options.files ?? noFiles,
		id,
	}
}

const inactiveSelfMedia = (
	status: Exclude<SelfMedia['status'], 'live'> = 'idle',
): SelfMedia => ({ status })

const liveSelfMedia = (
	options: {
		cameraEnabled?: boolean
		microphoneEnabled?: boolean
		screenAvailable?: boolean
	} = {},
): SelfMedia => {
	const camera = {
		enabled: options.cameraEnabled ?? false,
		readyState: 'live',
	} as MediaStreamTrack
	const microphone = {
		enabled: options.microphoneEnabled ?? true,
		readyState: 'live',
	} as MediaStreamTrack
	const deviceStream = {
		getAudioTracks: () => [microphone],
		getTracks: () => [microphone, camera],
		getVideoTracks: () => [camera],
	} as MediaStream

	return {
		deviceStream,
		publishedStream: new MediaStream(),
		screen: {
			status: options.screenAvailable === false ? 'unavailable' : 'available',
			stream: null,
		},
		status: 'live',
	}
}

const hostInvite = (
	overrides: Partial<Omit<HostInviteState, 'side'>> = {},
): HostInviteState => {
	return {
		side: 'host',
		manualPhase: 'waiting-for-reply',
		inviteLink: SAMPLE_INVITE_LINK,
		inviteLinkPhase: 'ready',
		inviteCode: SAMPLE_INVITE_CODE,
		replyText: '',
		issue: null,
		...overrides,
	}
}

const guestJoin = (
	overrides: {
		hostPresent?: boolean | null
		inviteText?: string
		issue?: GuestJoinState['issue']
		relayFallbackSecondsLeft?: number | null
		replyCode?: string
		status?: GuestJoinState['status']
	} = {},
): GuestJoinState => {
	const base = {
		side: 'guest' as const,
		inviteText: overrides.inviteText ?? '',
		issue: overrides.issue ?? null,
	}
	const status = overrides.status ?? 'needs-invite'
	if (status === 'discovering-host') {
		return {
			...base,
			hostPresent: overrides.hostPresent ?? null,
			relayFallbackSecondsLeft: overrides.relayFallbackSecondsLeft ?? null,
			status,
		}
	}
	if (status === 'reply-ready') {
		return { ...base, replyCode: overrides.replyCode ?? '', status }
	}
	return { ...base, status }
}

const fixture = (id: string, title: string, view: RoomViewProps): UiFixture => {
	return {
		id,
		title,
		render: () => <RoomView {...view} />,
	}
}

const room = (props: {
	entry: RoomEntryState
	themeSeed: string
	peers?: RoomPeer[]
	relayMetering?: RelayMetering | null
	self?: Partial<RoomViewProps['room']['self']>
	selfMedia?: SelfMedia
	canClaimInviteAsHost?: boolean
	blipDraft?: string
	fileTransferIssue?: RoomViewProps['room']['self']['fileTransferIssue']
}): RoomViewProps => {
	return {
		room: {
			commands: fixtureCommands,
			canClaimInviteAsHost: () => props.canClaimInviteAsHost ?? false,
			peers: {
				all: () => props.peers ?? [],
			},
			self: {
				blip: props.self?.blip ?? null,
				blipDraft: props.blipDraft ?? props.self?.blipDraft ?? '',
				fileTransferIssue:
					props.fileTransferIssue ?? props.self?.fileTransferIssue ?? null,
				files: props.self?.files ?? noFiles,
				media: props.self?.media ?? props.selfMedia ?? inactiveSelfMedia(),
			},
			state: {
				entry: props.entry,
				relayMetering: props.relayMetering ?? null,
				themeSeed: props.themeSeed,
			},
		},
	}
}

export const uiFixtures: UiFixture[] = [
	fixture(
		'welcome-host',
		'Welcome host',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			entry: hostInvite(),
		}),
	),
	fixture(
		'media-requesting',
		'Media requesting',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfMedia: inactiveSelfMedia('requesting'),
			entry: hostInvite({
				manualPhase: 'preparing-code',
				inviteLink: '',
				inviteLinkPhase: 'preparing',
				inviteCode: '',
			}),
		}),
	),
	fixture(
		'media-denied',
		'Media denied',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfMedia: inactiveSelfMedia('denied'),
			entry: hostInvite(),
		}),
	),
	fixture(
		'host-link-failed',
		'Host link failed',
		room({
			themeSeed: SAMPLE_INVITE_CODE,
			entry: hostInvite({ inviteLinkPhase: 'failed' }),
		}),
	),
	fixture(
		'guest-needs-invite',
		'Guest needs invite',
		room({
			themeSeed: 'guest-needs-invite',
			entry: guestJoin(),
		}),
	),
	fixture(
		'reply-ready',
		'Reply ready',
		room({
			themeSeed: SAMPLE_REPLY,
			peers: [fixturePeer(HOST_ID)],
			entry: guestJoin({
				status: 'reply-ready',
				inviteText: SAMPLE_OFFER,
				replyCode: SAMPLE_REPLY,
			}),
		}),
	),
	fixture(
		'guest-link-finding',
		'Guest link finding',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			peers: [fixturePeer(HOST_ID)],
			entry: guestJoin({
				status: 'discovering-host',
				inviteText: SAMPLE_INVITE_LINK,
				hostPresent: true,
				relayFallbackSecondsLeft: 5,
			}),
		}),
	),
	fixture(
		'guest-link-relay-offered',
		'Guest link relay offered',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			peers: [fixturePeer(HOST_ID)],
			entry: guestJoin({
				status: 'discovering-host',
				inviteText: SAMPLE_INVITE_LINK,
				hostPresent: true,
				relayFallbackSecondsLeft: 0,
			}),
		}),
	),
	fixture(
		'guest-link-relay-quota-exceeded',
		'Guest link relay quota exceeded',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			peers: [fixturePeer(HOST_ID)],
			entry: guestJoin({
				status: 'discovering-host',
				inviteText: SAMPLE_INVITE_LINK,
				hostPresent: true,
				issue: 'relay-quota-exceeded',
			}),
		}),
	),
	fixture(
		'guest-link-unhosted',
		'Guest link unhosted',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			canClaimInviteAsHost: true,
			entry: guestJoin({
				status: 'discovering-host',
				inviteText: SAMPLE_INVITE_LINK,
				hostPresent: false,
			}),
		}),
	),
	fixture(
		'guest-link-host-present-service-failed',
		'Guest link service failed with host present',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			entry: guestJoin({
				status: 'discovering-host',
				inviteText: SAMPLE_INVITE_LINK,
				hostPresent: true,
				issue: 'discovery-unreachable',
			}),
		}),
	),
	fixture(
		'file-transfer-stopped',
		'File transfer stopped',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			self: {
				blip: null,
				files: [
					{
						id: 'stopped-file',
						name: 'camera-roll.zip',
						transferredBytes: 42,
						size: 100,
						state: 'failed',
						url: null,
					},
				],
			},
			selfMedia: liveSelfMedia({ cameraEnabled: true }),
			fileTransferIssue: 'stopped',
			peers: [fixturePeer(OLEG_ID)],
			entry: hostInvite(),
		}),
	),
	fixture(
		'connected-strip',
		'Connected strip',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			self: {
				blip: 'dragged a few screenshots over',
				files: [
					{
						id: 'local-file',
						name: 'screenshots.zip',
						transferredBytes: 64,
						size: 100,
						state: 'sending',
						url: null,
					},
					{
						id: 'backup-file',
						name: 'backup.zip',
						transferredBytes: 42,
						size: 100,
						state: 'sending',
						url: null,
					},
				],
			},
			selfMedia: liveSelfMedia({ screenAvailable: false }),
			blipDraft: 'dragged a few screenshots over',
			peers: [
				fixturePeer(OLEG_ID, {
					blip: 'send the raw photos too',
					files: [
						{
							id: 'oleg-file',
							name: 'photo-export.zip',
							transferredBytes: 37,
							size: 100,
							state: 'receiving',
							url: null,
						},
					],
					connected: true,
				}),
				fixturePeer(NADIA_ID, { connected: true }),
			],
			entry: hostInvite(),
		}),
	),
	fixture(
		'guest-connected-relay',
		'Guest connected relay',
		room({
			themeSeed: HOST_ID,
			relayMetering: { bytesLeft: 1_600_000_000, secondsLeft: 48 * 60 },
			selfMedia: liveSelfMedia({ cameraEnabled: true }),
			peers: [
				fixturePeer(HOST_ID, {
					connected: true,
					mediaPresence: {
						cameraEnabled: true,
						microphoneEnabled: true,
						screenEnabled: false,
					},
				}),
			],
			entry: guestJoin({
				status: 'connected',
				inviteText: SAMPLE_OFFER,
				replyCode: SAMPLE_REPLY,
			}),
		}),
	),
	fixture(
		'closed-room',
		'Closed room',
		room({
			themeSeed: 'closed-room',
			entry: { side: 'closed' },
		}),
	),
	fixture(
		'error-screen',
		'Error screen',
		room({
			themeSeed: 'error-screen',
			entry: hostInvite({
				manualPhase: 'preparing-code',
				inviteLink: '',
				inviteLinkPhase: 'failed',
				inviteCode: '',
				issue: 'invite-creation-failed',
			}),
		}),
	),
]
