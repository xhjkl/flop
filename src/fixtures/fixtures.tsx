import type { JSX } from 'solid-js'
import type { HostInviteMode } from '../connection-card'
import { parseParticipantId } from '../protocol'
import type { ParticipantView, RoomState } from '../room'
import type {
	ClosedEntryState,
	GuestJoinState,
	HostInviteState,
} from '../room/entry/state'
import type { ParticipantActivity } from '../room/participant'
import type { RelayMetering } from '../room/relay'
import { RoomView, type RoomViewProps } from '../room-view'
import type { SelfMedia } from '../self-media'

export type UiFixture = {
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

const noop = () => {}
const noopFiles = (_files: File[]) => {}
const noopText = (_text: string) => {}
const noopTextMaybe = (_text?: string) => {}

const fixtureActions: RoomViewProps['room']['actions'] = {
	acceptReply: noopTextMaybe,
	becomeGuest: noop,
	becomeHost: noop,
	claimInviteLinkAsHost: noop,
	copyInviteLink: noop,
	copyInviteCode: noop,
	copyReplyCode: noop,
	createReply: noopTextMaybe,
	dismissBlipIssue: noop,
	enableSelfMedia: noop,
	sendBlip: noop,
	sendFiles: noopFiles,
	setBlipText: noopText,
	setInviteText: noopText,
	setReplyText: noopText,
	toggleCamera: noop,
	toggleMicrophone: noop,
	toggleScreen: noop,
	tryRelay: noop,
}

const emptyActivity: ParticipantActivity = { blip: null, files: [] }
const emptyComposer = { issue: null, text: '' }

const selfMedia = (overrides: Partial<SelfMedia> = {}): SelfMedia => {
	return {
		status: 'ready',
		issue: null,
		outboundStream: null,
		deviceStream: null,
		screenStream: null,
		cameraAvailable: false,
		cameraEnabled: false,
		microphoneAvailable: false,
		microphoneEnabled: false,
		screenAvailable: true,
		screenEnabled: false,
		screenRequesting: false,
		...overrides,
	}
}

const liveSelfMedia = (overrides: Partial<SelfMedia> = {}) => {
	return selfMedia({
		status: 'live',
		cameraAvailable: true,
		cameraEnabled: false,
		microphoneAvailable: true,
		microphoneEnabled: true,
		...overrides,
	})
}

const hostInvite = (
	overrides: Partial<Omit<HostInviteState, 'side'>> = {},
): HostInviteState => {
	return {
		side: 'host',
		status: 'invite-ready',
		inviteLink: SAMPLE_INVITE_LINK,
		inviteLinkStatus: 'ready',
		inviteCode: SAMPLE_INVITE_CODE,
		replyText: '',
		issue: null,
		...overrides,
	}
}

const guestJoin = (
	overrides: Partial<Omit<GuestJoinState, 'side'>> = {},
): GuestJoinState => {
	return {
		side: 'guest',
		status: 'needs-invite',
		inviteText: '',
		inviteLinkPresence: null,
		relayFallbackSecondsLeft: null,
		replyCode: '',
		issue: null,
		...overrides,
	}
}

const closedEntry = (
	overrides: Partial<Omit<ClosedEntryState, 'side'>> = {},
): ClosedEntryState => {
	return {
		side: 'closed',
		issue: null,
		...overrides,
	}
}

const fixture = (id: string, title: string, view: RoomViewProps): UiFixture => {
	return {
		id,
		title,
		render: () => <RoomView {...view} />,
	}
}

const room = (
	props: {
		entry: RoomState['entry']
		themeSeed: string
		hostInviteMode?: HostInviteMode
		peers?: ParticipantView[]
		relayMetering?: RelayMetering | null
		selfActivity?: ParticipantActivity
		selfMedia?: SelfMedia
		canClaimFindingInviteLink?: boolean
	} & Partial<Pick<RoomState, 'blipComposer'>>,
): RoomViewProps => {
	return {
		hostInviteMode: props.hostInviteMode ?? null,
		room: {
			actions: fixtureActions,
			canClaimFindingInviteLink: () => props.canClaimFindingInviteLink ?? false,
			peers: () => props.peers ?? [],
			selfActivity: () => props.selfActivity ?? emptyActivity,
			state: {
				blipComposer: props.blipComposer ?? emptyComposer,
				entry: props.entry,
				relayMetering: props.relayMetering ?? null,
				selfMedia: props.selfMedia ?? selfMedia(),
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
			selfMedia: selfMedia({ status: 'requesting' }),
			entry: hostInvite({
				status: 'creating-invite',
				inviteLink: '',
				inviteLinkStatus: 'idle',
				inviteCode: '',
			}),
		}),
	),
	fixture(
		'media-denied',
		'Media denied',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfMedia: selfMedia({
				status: 'denied',
				issue:
					'Camera or microphone access was denied. Allow access in your browser, then try again.',
			}),
			entry: hostInvite(),
		}),
	),
	fixture(
		'host-code-fallback',
		'Host code fallback',
		room({
			themeSeed: SAMPLE_INVITE_CODE,
			hostInviteMode: 'code',
			entry: hostInvite(),
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
			peers: [
				{
					activity: emptyActivity,
					id: HOST_ID,
					mediaState: null,
					mediaStream: null,
					connectionState: 'waiting',
				},
			],
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
			peers: [
				{
					activity: emptyActivity,
					id: HOST_ID,
					mediaState: null,
					mediaStream: null,
					connectionState: 'waiting',
				},
			],
			entry: guestJoin({
				status: 'finding-link',
				inviteText: SAMPLE_INVITE_LINK,
				inviteLinkPresence: { guests: 1, hosts: 1 },
				relayFallbackSecondsLeft: 5,
			}),
		}),
	),
	fixture(
		'guest-link-relay-offered',
		'Guest link relay offered',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			peers: [
				{
					activity: emptyActivity,
					id: HOST_ID,
					mediaState: null,
					mediaStream: null,
					connectionState: 'waiting',
				},
			],
			entry: guestJoin({
				status: 'finding-link',
				inviteText: SAMPLE_INVITE_LINK,
				inviteLinkPresence: { guests: 1, hosts: 1 },
				relayFallbackSecondsLeft: 0,
			}),
		}),
	),
	fixture(
		'guest-link-relay-quota-exceeded',
		'Guest link relay quota exceeded',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			peers: [
				{
					activity: emptyActivity,
					id: HOST_ID,
					mediaState: null,
					mediaStream: null,
					connectionState: 'waiting',
				},
			],
			entry: guestJoin({
				status: 'finding-link',
				inviteText: SAMPLE_INVITE_LINK,
				inviteLinkPresence: { guests: 1, hosts: 1 },
				issue: 'relay-quota-exceeded',
			}),
		}),
	),
	fixture(
		'guest-link-unhosted',
		'Guest link unhosted',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			canClaimFindingInviteLink: true,
			entry: guestJoin({
				status: 'finding-link',
				inviteText: SAMPLE_INVITE_LINK,
				inviteLinkPresence: { guests: 0, hosts: 0 },
			}),
		}),
	),
	fixture(
		'guest-link-host-present-service-failed',
		'Guest link service failed with host present',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			entry: guestJoin({
				status: 'finding-link',
				inviteText: SAMPLE_INVITE_LINK,
				inviteLinkPresence: { guests: 1, hosts: 1 },
				issue: 'discovery-unreachable',
			}),
		}),
	),
	fixture(
		'blip-issue-file-stopped',
		'Blip issue file stopped',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfActivity: {
				blip: null,
				files: [
					{
						id: 'stopped-file',
						name: 'camera-roll.zip',
						transferredBytes: 42,
						size: 100,
						state: 'error',
						url: null,
					},
				],
			},
			selfMedia: liveSelfMedia({ cameraEnabled: true }),
			blipComposer: {
				issue: 'stopped',
				text: '',
			},
			peers: [
				{
					activity: emptyActivity,
					id: OLEG_ID,
					mediaState: null,
					mediaStream: null,
					connectionState: 'waiting',
				},
			],
			entry: hostInvite(),
		}),
	),
	fixture(
		'connected-strip',
		'Connected strip',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfActivity: {
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
			blipComposer: {
				issue: null,
				text: 'dragged a few screenshots over',
			},
			peers: [
				{
					activity: {
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
					},
					id: OLEG_ID,
					mediaState: null,
					mediaStream: null,
					connectionState: 'live',
				},
				{
					activity: emptyActivity,
					id: NADIA_ID,
					mediaState: null,
					mediaStream: null,
					connectionState: 'live',
				},
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
				{
					activity: emptyActivity,
					id: HOST_ID,
					mediaState: {
						cameraEnabled: true,
						microphoneEnabled: true,
						screenEnabled: false,
					},
					mediaStream: null,
					connectionState: 'live',
				},
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
			entry: closedEntry(),
		}),
	),
	fixture(
		'error-screen',
		'Error screen',
		room({
			themeSeed: 'error-screen',
			entry: hostInvite({
				status: 'creating-invite',
				inviteLink: '',
				inviteLinkStatus: 'failed',
				inviteCode: '',
				issue: 'invite-creation-failed',
			}),
		}),
	),
]

export const getFixture = (id: string | null): UiFixture | null => {
	if (id == null) return null
	return uiFixtures.find((fixture) => fixture.id === id) ?? null
}
