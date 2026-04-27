import type { JSX } from 'solid-js'
import type { RoomPeer, RoomState } from '../room'
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
const SAMPLE_INVITE_LINK = `https://flop.local/#${encodeURIComponent(SAMPLE_OFFER)}`
const SAMPLE_AUTO_LINK = 'https://flop.local/#ybybybybybybybybybybybybyb'
const SAMPLE_REPLY =
	'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=flop-reply\nt=0 0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel'
const HOST_ID = '48b6a1e2c59d730f'
const MARA_ID = '79df2a4c038be116'
const JO_ID = 'b05e9d8328aa41c7'

const noop = () => {}
const noopFiles = (_files: File[]) => {}
const noopText = (_text: string) => {}
const noopTextMaybe = (_text?: string) => {}

const fixtureActions: RoomViewProps['room']['actions'] = {
	acceptReply: noopTextMaybe,
	becomeGuest: noop,
	becomeHost: noop,
	copyAutoInviteLink: noop,
	copyManualInviteLink: noop,
	copyReplyCode: noop,
	createReply: noopTextMaybe,
	enableSelfMedia: noop,
	sendBlip: noop,
	sendFiles: noopFiles,
	setBlipText: noopText,
	setInviteText: noopText,
	setReplyText: noopText,
	toggleCamera: noop,
	toggleMicrophone: noop,
}

const emptyActivity: PortraitActivityState = { blip: null, files: [] }
const emptyComposer = { issue: null, text: '' }

const selfMedia = (overrides: Partial<SelfMedia> = {}): SelfMedia => {
	return {
		status: 'ready',
		issue: null,
		stream: null,
		cameraAvailable: false,
		cameraEnabled: false,
		microphoneAvailable: false,
		microphoneEnabled: false,
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
		autoInviteLink: SAMPLE_AUTO_LINK,
		autoStatus: 'ready',
		manualInviteLink: SAMPLE_INVITE_LINK,
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

const room = (
	props: {
		connection: RoomState['connection']
		themeSeed: string
		hostInviteMode?: RoomViewProps['hostInviteMode']
		peers?: RoomPeer[]
		selfActivity?: PortraitActivityState
		selfMedia?: SelfMedia
	} & Partial<Pick<RoomState, 'blipComposer'>>,
): RoomViewProps => {
	return {
		hostInviteMode: props.hostInviteMode,
		room: {
			actions: fixtureActions,
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
			themeSeed: SAMPLE_AUTO_LINK,
			connection: hostConnection(),
		}),
	),
	fixture(
		'media-requesting',
		'Media requesting',
		'The browser permission prompt is outstanding and the local portrait is waiting.',
		room({
			themeSeed: SAMPLE_AUTO_LINK,
			selfMedia: selfMedia({ status: 'requesting' }),
			connection: hostConnection(),
		}),
	),
	fixture(
		'media-denied',
		'Media denied',
		'The shared self portrait renders the media failure branch and retry action.',
		room({
			themeSeed: SAMPLE_AUTO_LINK,
			selfMedia: selfMedia({
				status: 'denied',
				issue:
					'Camera or microphone access was denied. Allow it in the browser, then try again.',
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
				autoInviteLink: '',
				autoStatus: 'idle',
				manualInviteLink: '',
			}),
		}),
	),
	fixture(
		'host-link-finding',
		'Host link finding',
		'The host has an invite code, but the tracker invite link is still preparing.',
		room({
			themeSeed: SAMPLE_AUTO_LINK,
			connection: hostConnection({ autoStatus: 'finding' }),
		}),
	),
	fixture(
		'host-code-fallback',
		'Host code fallback',
		'The same connection card opened to the invite code and reply code paste pane.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
			hostInviteMode: 'code',
			connection: hostConnection(),
		}),
	),
	fixture(
		'host-accepting-reply',
		'Host accepting reply',
		'The host has pasted a reply code and the connection card is temporarily busy.',
		room({
			themeSeed: SAMPLE_INVITE_LINK,
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
		'The guest accepted an invite and is building the reply code.',
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
					state: 'waiting',
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
			themeSeed: SAMPLE_AUTO_LINK,
			peers: [
				{
					activity: emptyActivity,
					id: HOST_ID,
					state: 'waiting',
				},
			],
			connection: guestConnection({
				status: 'finding-link',
				inviteText: SAMPLE_AUTO_LINK,
			}),
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
						progress: 64,
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
								id: 'mara-file',
								name: 'photo-export.zip',
								progress: 37,
								state: 'receiving',
								url: null,
							},
						],
					},
					id: MARA_ID,
					state: 'live',
				},
				{
					activity: emptyActivity,
					id: JO_ID,
					state: 'live',
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
					mediaState: { cameraEnabled: true, microphoneEnabled: true },
					state: 'live',
				},
			],
			connection: guestConnection({
				status: 'connected',
				inviteText: SAMPLE_OFFER,
				replyCode: SAMPLE_REPLY,
			}),
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
				autoInviteLink: '',
				autoStatus: 'failed',
				manualInviteLink: '',
				issue: 'Could not create the invite link or invite code.',
			}),
		}),
	),
]

export const getFixture = (id: string | null): UiFixture | null => {
	if (id == null) return null
	return uiFixtures.find((fixture) => fixture.id === id) ?? null
}
