import type { JSX } from 'solid-js'
import { ConnectionCard } from '../connection-card'
import { Room } from '../portraits'
import type { RoomPeer, RoomState } from '../room'
import { blipIssueCopy, statusCopy } from '../room/status-copy'
import { RoomView, type RoomViewProps } from '../room-view'
import type { SelfMedia } from '../self-media'
import type {
	ClosedConnectionState,
	GuestConnectionState,
	HostConnectionState,
	PortraitActivityState,
} from '../state'

export type UiFixture = {
	id: string
	title: string
	description: string
	render: () => JSX.Element
}

const SAMPLE_OFFER =
	'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=flop\nt=0 0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel'
const SAMPLE_INVITE_CODE = `https://flop.local/#${encodeURIComponent(SAMPLE_OFFER)}`
const SAMPLE_INVITE_LINK = 'https://flop.local/#ybybybybybybybybybybybybyb'
const SAMPLE_REPLY =
	'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=flop-reply\nt=0 0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel'
const HOST_ID = '48b6a1e2c59d730f'
const OLEG_ID = '79df2a4c038be116'
const NADIA_ID = 'b05e9d8328aa41c7'

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
}

const emptyActivity: PortraitActivityState = { blip: null, files: [] }
const emptyComposer = { issue: null, text: '' }

const selfMedia = (overrides: Partial<SelfMedia> = {}): SelfMedia => {
	return {
		status: 'ready',
		issue: null,
		stream: null,
		cameraStream: null,
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

const hostConnection = (
	overrides: Partial<Omit<HostConnectionState, 'side'>> = {},
): HostConnectionState => {
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

const guestConnection = (
	overrides: Partial<Omit<GuestConnectionState, 'side'>> = {},
): GuestConnectionState => {
	return {
		side: 'guest',
		status: 'needs-invite',
		inviteText: '',
		inviteLinkPresence: null,
		replyCode: '',
		issue: null,
		...overrides,
	}
}

const closedConnection = (
	overrides: Partial<Omit<ClosedConnectionState, 'side'>> = {},
): ClosedConnectionState => {
	return {
		side: 'closed',
		issue: null,
		...overrides,
	}
}

const fixture = (
	id: string,
	title: string,
	description: string,
	view: RoomViewProps,
): UiFixture => {
	return {
		id,
		title,
		description,
		render: () => <RoomView {...view} />,
	}
}

const connectionCardFixture = (
	id: string,
	title: string,
	description: string,
	connection: RoomState['connection'],
): UiFixture => {
	return {
		id,
		title,
		description,
		render: () => (
			<Room themeSeed={HOST_ID}>
				<ConnectionCard
					connection={connection}
					canClaimFindingInviteLink={false}
					canJoinExistingRoom
					onAcceptReply={noopTextMaybe}
					onBecomeGuest={noop}
					onBecomeHost={noop}
					onClaimInviteLinkAsHost={noop}
					onCopyInviteLink={noop}
					onCopyInviteCode={noop}
					onCopyReplyCode={noop}
					onCreateReply={noopTextMaybe}
					onSetInviteText={noopText}
					onSetReplyText={noopText}
				/>
			</Room>
		),
	}
}

const room = (
	props: {
		connection: RoomState['connection']
		themeSeed: string
		hostInviteMode?: RoomViewProps['hostInviteMode']
		peers?: RoomPeer[]
		selfActivity?: PortraitActivityState
		selfMedia?: SelfMedia
		canClaimFindingInviteLink?: boolean
	} & Partial<Pick<RoomState, 'blipComposer'>>,
): RoomViewProps => {
	return {
		hostInviteMode: props.hostInviteMode,
		room: {
			actions: fixtureActions,
			canClaimFindingInviteLink: () => props.canClaimFindingInviteLink ?? false,
			peers: () => props.peers ?? [],
			selfActivity: () => props.selfActivity ?? emptyActivity,
			state: {
				blipComposer: props.blipComposer ?? emptyComposer,
				connection: props.connection,
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
		'The first host screen: welcome copy, media enable action, and a ready invite link.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			connection: hostConnection(),
		}),
	),
	fixture(
		'media-requesting',
		'Media requesting',
		'Browser permission prompt is open and the local portrait is waiting.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfMedia: selfMedia({ status: 'requesting' }),
			connection: hostConnection(),
		}),
	),
	fixture(
		'media-denied',
		'Media denied',
		'The shared self portrait renders the media failure branch and retry action.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfMedia: selfMedia({
				status: 'denied',
				issue:
					'Camera or microphone access was denied. Allow access in your browser, then try again.',
			}),
			connection: hostConnection(),
		}),
	),
	fixture(
		'host-invite-creating',
		'Host invite creating',
		'The host room exists before either invite surface is ready.',
		room({
			themeSeed: HOST_ID,
			connection: hostConnection({
				status: 'creating-invite',
				inviteLink: '',
				inviteLinkStatus: 'idle',
				inviteCode: '',
			}),
		}),
	),
	fixture(
		'host-link-finding',
		'Host link finding',
		'The host has an invite code, but the beacon invite link is still preparing.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			connection: hostConnection({ inviteLinkStatus: 'finding' }),
		}),
	),
	fixture(
		'host-code-fallback',
		'Host code fallback',
		'Connection card opened to the invite code and reply code paste pane.',
		room({
			themeSeed: SAMPLE_INVITE_CODE,
			hostInviteMode: 'code',
			connection: hostConnection(),
		}),
	),
	fixture(
		'host-accepting-reply',
		'Host accepting reply',
		'The host has pasted a reply code and the connection card is temporarily busy.',
		room({
			themeSeed: SAMPLE_INVITE_CODE,
			hostInviteMode: 'code',
			connection: hostConnection({
				status: 'accepting-reply',
				replyText: SAMPLE_REPLY,
			}),
		}),
	),
	fixture(
		'guest-needs-invite',
		'Guest needs invite',
		'The guest has not received an invite yet and can still start a room instead.',
		room({
			themeSeed: 'guest-needs-invite',
			connection: guestConnection(),
		}),
	),
	fixture(
		'guest-creating-reply',
		'Guest creating reply code',
		'Guest accepted an invite and is building the reply code.',
		room({
			themeSeed: SAMPLE_OFFER,
			connection: guestConnection({
				status: 'creating-reply',
				inviteText: SAMPLE_OFFER,
			}),
		}),
	),
	fixture(
		'reply-ready',
		'Reply ready',
		'You opened an invite and now need to send one reply code back.',
		room({
			themeSeed: SAMPLE_REPLY,
			peers: [
				{
					activity: emptyActivity,
					id: HOST_ID,
					connectionState: 'waiting',
				},
			],
			connection: guestConnection({
				status: 'reply-ready',
				inviteText: SAMPLE_OFFER,
				replyCode: SAMPLE_REPLY,
			}),
		}),
	),
	fixture(
		'guest-link-finding',
		'Guest link finding',
		'The guest opened an invite link and should wait, not create a reply code.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			peers: [
				{
					activity: emptyActivity,
					id: HOST_ID,
					connectionState: 'waiting',
				},
			],
			connection: guestConnection({
				status: 'finding-link',
				inviteText: SAMPLE_INVITE_LINK,
				inviteLinkPresence: { guests: 1, hosts: 1, peers: 1 },
			}),
		}),
	),
	fixture(
		'guest-link-unhosted',
		'Guest link unhosted',
		'The guest has the secret invite link, but no host is currently present.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			canClaimFindingInviteLink: true,
			connection: guestConnection({
				status: 'finding-link',
				inviteText: SAMPLE_INVITE_LINK,
				inviteLinkPresence: { guests: 0, hosts: 0, peers: 0 },
			}),
		}),
	),
	fixture(
		'guest-link-host-present-service-failed',
		'Guest link service failed with host present',
		'The guest saw a host before the invite-link service became unreachable.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			connection: guestConnection({
				status: 'finding-link',
				inviteText: SAMPLE_INVITE_LINK,
				inviteLinkPresence: { guests: 1, hosts: 1, peers: 2 },
				issue: statusCopy.inviteLinkUnreachable,
			}),
		}),
	),
	fixture(
		'blip-issue-no-peers',
		'Blip issue no peers',
		'File-drop feedback lives in the self portrait when nobody can receive files.',
		room({
			themeSeed: 'blip-issue-no-peers',
			blipComposer: {
				issue: blipIssueCopy.fileNoPeers,
				text: '',
			},
			connection: hostConnection(),
		}),
	),
	fixture(
		'blip-issue-partial-file',
		'Blip issue partial file',
		'Partial file delivery keeps a visible issue while the local file chip is ready.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfActivity: {
				blip: 'shared the screenshots',
				files: [
					{
						id: 'partial-file',
						name: 'screenshots.zip',
						receivedBytes: 100,
						size: 100,
						state: 'ready',
						url: null,
					},
				],
			},
			selfMedia: liveSelfMedia(),
			blipComposer: {
				issue: blipIssueCopy.filePartialDelivery,
				text: 'shared the screenshots',
			},
			peers: [
				{
					activity: emptyActivity,
					id: OLEG_ID,
					connectionState: 'live',
				},
				{
					activity: emptyActivity,
					id: NADIA_ID,
					connectionState: 'waiting',
				},
			],
			connection: hostConnection(),
		}),
	),
	fixture(
		'blip-issue-file-stopped',
		'Blip issue file stopped',
		'Failed file delivery marks the chip as errored and explains what happened.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfActivity: {
				blip: null,
				files: [
					{
						id: 'stopped-file',
						name: 'camera-roll.zip',
						receivedBytes: 42,
						size: 100,
						state: 'error',
						url: null,
					},
				],
			},
			selfMedia: liveSelfMedia({ cameraEnabled: true }),
			blipComposer: {
				issue: blipIssueCopy.fileStopped,
				text: '',
			},
			peers: [
				{
					activity: emptyActivity,
					id: OLEG_ID,
					connectionState: 'waiting',
				},
			],
			connection: hostConnection(),
		}),
	),
	fixture(
		'connected-strip',
		'Connected strip',
		'Several live portraits, transfer activity, and the host invite affordance at the end.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfActivity: {
				blip: 'dragged a few screenshots over',
				files: [
					{
						id: 'local-file',
						name: 'screenshots.zip',
						receivedBytes: 64,
						size: 100,
						state: 'sending',
						url: null,
					},
					{
						id: 'backup-file',
						name: 'backup.zip',
						receivedBytes: 42,
						size: 100,
						state: 'sending',
						url: null,
					},
				],
			},
			selfMedia: liveSelfMedia(),
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
								receivedBytes: 37,
								size: 100,
								state: 'receiving',
								url: null,
							},
						],
					},
					id: OLEG_ID,
					connectionState: 'live',
				},
				{
					activity: emptyActivity,
					id: NADIA_ID,
					connectionState: 'live',
				},
			],
			connection: hostConnection(),
		}),
	),
	fixture(
		'connected-no-screen-share',
		'No screen share support',
		'Live self controls with screen sharing unavailable, so scr renders disabled.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			selfActivity: {
				blip: 'dragged a few screenshots over',
				files: [],
			},
			selfMedia: liveSelfMedia({
				cameraEnabled: true,
				screenAvailable: false,
			}),
			blipComposer: {
				issue: null,
				text: 'dragged a few screenshots over',
			},
			peers: [
				{
					activity: emptyActivity,
					id: OLEG_ID,
					connectionState: 'live',
				},
			],
			connection: hostConnection(),
		}),
	),
	fixture(
		'guest-connected',
		'Guest connected',
		'The connected guest strip is people-first, so the connection card disappears.',
		room({
			themeSeed: HOST_ID,
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
					connectionState: 'live',
				},
			],
			connection: guestConnection({
				status: 'connected',
				inviteText: SAMPLE_OFFER,
				replyCode: SAMPLE_REPLY,
			}),
		}),
	),
	connectionCardFixture(
		'connected-card',
		'Connected card',
		'Component fixture for the connected connection-card branch hidden by the app strip.',
		guestConnection({
			status: 'connected',
			inviteText: SAMPLE_OFFER,
			replyCode: SAMPLE_REPLY,
		}),
	),
	fixture(
		'closed-room',
		'Closed room',
		'The room is dead, peer cards are gone, and recovery lives inside the connection card.',
		room({
			themeSeed: 'closed-room',
			connection: closedConnection(),
		}),
	),
	fixture(
		'error-screen',
		'Error screen',
		'The strip still holds the error instead of switching paradigms.',
		room({
			themeSeed: 'error-screen',
			connection: hostConnection({
				status: 'creating-invite',
				inviteLink: '',
				inviteLinkStatus: 'failed',
				inviteCode: '',
				issue: 'Could not create an invite link or invite code.',
			}),
		}),
	),
]

export const getFixture = (id: string | null): UiFixture | null => {
	if (id == null) return null
	return uiFixtures.find((fixture) => fixture.id === id) ?? null
}
