import type { JSX } from 'solid-js'
import { ConnectionCard } from '../connection-card'
import { PersonCard, Room, SelfMediaCard } from '../portraits'
import type { SelfMedia } from '../self-media'
import type { ConnectionState, PortraitActivityState } from '../state'

export type UiFixture = {
	id: string
	title: string
	description: string
	render: () => JSX.Element
}

const SAMPLE_OFFER =
	'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=flop\nt=0 0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel'
const SAMPLE_INVITE_LINK = `https://flop.local/#${encodeURIComponent(SAMPLE_OFFER)}`
const SAMPLE_REPLY =
	'v=0\no=- 0 0 IN IP4 127.0.0.1\ns=flop-reply\nt=0 0\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel'
const HOST_ID = '48b6a1e2c59d730f'
const MARA_ID = '79df2a4c038be116'
const JO_ID = 'b05e9d8328aa41c7'

const noop = () => {}
const noopText = (_text: string) => {}
const emptyActivity: PortraitActivityState = { blip: null, files: [] }
const fixtureComposer = { issue: null, text: '' }
const idleMedia: SelfMedia = {
	status: 'ready',
	issue: null,
	stream: null,
	cameraAvailable: false,
	cameraEnabled: false,
	microphoneAvailable: false,
	microphoneEnabled: false,
}
const liveMedia: SelfMedia = {
	status: 'live',
	issue: null,
	stream: null,
	cameraAvailable: true,
	cameraEnabled: false,
	microphoneAvailable: true,
	microphoneEnabled: true,
}

const fixture = (
	id: string,
	title: string,
	description: string,
	render: () => JSX.Element,
): UiFixture => {
	return { id, title, description, render }
}

const connectionCard = (connection: ConnectionState, hasPeers = false) => {
	return (
		<ConnectionCard
			connection={connection}
			hasPeers={hasPeers}
			onAcceptReply={noop}
			onBecomeGuest={noop}
			onBecomeHost={noop}
			onCopyInviteLink={noop}
			onCopyReplyCode={noop}
			onCreateReply={noop}
			onSetInviteText={noopText}
			onSetReplyText={noopText}
		/>
	)
}

// Fixtures are sculpting shortcuts, not a second product model.
const selfCard = (activity = emptyActivity) => {
	return (
		<SelfMediaCard
			activity={activity}
			canBlip
			blipComposer={fixtureComposer}
			media={idleMedia}
			title="you"
			onSendBlip={noop}
			onSetBlipText={noopText}
		/>
	)
}

const liveSelfCard = (activity = emptyActivity) => {
	return (
		<SelfMediaCard
			activity={activity}
			canBlip
			blipComposer={{ issue: null, text: activity.blip ?? '' }}
			media={liveMedia}
			cameraToggle={{ onPress: noop }}
			microphoneToggle={{ onPress: noop }}
			onSendBlip={noop}
			onSetBlipText={noopText}
		/>
	)
}

export const uiFixtures: UiFixture[] = [
	fixture(
		'main-screen',
		'Main screen',
		'The host is alone, invite ready, nothing else competing for attention.',
		() => (
			<Room themeSeed={SAMPLE_OFFER}>
				<SelfMediaCard
					activity={emptyActivity}
					canBlip
					blipComposer={fixtureComposer}
					media={idleMedia}
					title="welcome to flop"
					actions={[{ label: 'enable camera + mic' }]}
					onSendBlip={noop}
					onSetBlipText={noopText}
				>
					<p>
						Share an invite with another device, then send files
						device-to-device. Use the button below to turn on camera and
						microphone so other peers can see you.
					</p>
					{/* Future preflight? You'll get a quick mirror check before you go live. */}
				</SelfMediaCard>
				{connectionCard({
					side: 'host',
					status: 'invite-ready',
					inviteLink: SAMPLE_INVITE_LINK,
					replyText: '',
					issue: null,
				})}
			</Room>
		),
	),
	fixture(
		'reply-screen',
		'Reply screen',
		'You opened an invite and now need to send one reply back.',
		() => (
			<Room themeSeed={SAMPLE_REPLY}>
				{selfCard()}
				<PersonCard
					activity={emptyActivity}
					colorSeed={HOST_ID}
					state="waiting"
				/>
				{connectionCard({
					side: 'guest',
					status: 'reply-ready',
					inviteText: SAMPLE_OFFER,
					replyCode: SAMPLE_REPLY,
					issue: null,
				})}
			</Room>
		),
	),
	fixture(
		'connected-strip',
		'Connected strip',
		'Several live portraits, then the persistent invite.',
		() => (
			<Room themeSeed={SAMPLE_INVITE_LINK}>
				{liveSelfCard({
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
				})}
				<PersonCard
					activity={{
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
					}}
					colorSeed={MARA_ID}
					state="live"
				/>
				<PersonCard activity={emptyActivity} colorSeed={JO_ID} state="live" />
				{connectionCard(
					{
						side: 'host',
						status: 'invite-ready',
						inviteLink: SAMPLE_INVITE_LINK,
						replyText: '',
						issue: null,
					},
					true,
				)}
			</Room>
		),
	),
	fixture(
		'closed-room',
		'Closed room',
		'The room is dead, peer cards are gone, and recovery lives inside the connection card.',
		() => (
			<Room themeSeed="closed-room">
				{selfCard()}
				{connectionCard({
					side: 'closed',
					issue: null,
				})}
			</Room>
		),
	),
	fixture(
		'error-screen',
		'Error screen',
		'The strip still holds the error instead of switching paradigms.',
		() => (
			<Room themeSeed="error-screen">
				{selfCard()}
				{connectionCard({
					side: 'host',
					status: 'creating-invite',
					inviteLink: '',
					replyText: '',
					issue: 'Could not create an invite.',
				})}
			</Room>
		),
	),
]

export const getFixture = (id: string | null): UiFixture | null => {
	if (id == null) return null
	return uiFixtures.find((fixture) => fixture.id === id) ?? null
}
