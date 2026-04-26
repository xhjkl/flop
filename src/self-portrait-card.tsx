import { Match, Switch } from 'solid-js'
import { SelfMediaCard } from './portraits'
import type { SelfMedia, SelfMediaStatus } from './self-media'
import type { BlipComposerState, PortraitActivityState } from './state'

type SelfMediaFailureState = Extract<
	SelfMediaStatus,
	'denied' | 'missing' | 'unsupported' | 'error'
>

const selfMediaFailureTitles = {
	denied: 'Access denied',
	missing: 'No devices found',
	unsupported: 'Browser unsupported',
	error: 'Could not start media',
} satisfies Record<SelfMediaFailureState, string>

const mediaFailureIssue = (selfMedia: SelfMedia) => {
	return (
		selfMedia.issue ?? 'The browser could not open the camera and microphone.'
	)
}

const mediaFailureTitle = (status: SelfMediaStatus) => {
	return status in selfMediaFailureTitles
		? selfMediaFailureTitles[status as SelfMediaFailureState]
		: 'Could not start media'
}

const MediaFailureCard = (props: {
	activity: PortraitActivityState
	blipComposer: BlipComposerState
	canBlip: boolean
	title: string
	media: SelfMedia
	onEnableSelfMedia: () => void
	onSendBlip: () => void
	onSetBlipText: (text: string) => void
}) => {
	return (
		<SelfMediaCard
			activity={props.activity}
			blipComposer={props.blipComposer}
			canBlip={props.canBlip}
			media={props.media}
			title={props.title}
			actions={[{ label: 'try again', onPress: props.onEnableSelfMedia }]}
			onSendBlip={props.onSendBlip}
			onSetBlipText={props.onSetBlipText}
		>
			<p>{mediaFailureIssue(props.media)}</p>
			<p>Fix it and try again here.</p>
		</SelfMediaCard>
	)
}

export const SelfPortraitCard = (props: {
	activity: PortraitActivityState
	canBlip: boolean
	blipComposer: BlipComposerState
	media: SelfMedia
	onSendBlip: () => void
	onEnableSelfMedia: () => void
	onSetBlipText: (text: string) => void
	onToggleCamera: () => void
	onToggleMicrophone: () => void
}) => {
	return (
		// Welcome and permission are one portrait so the first step never feels like a modal.
		<Switch
			fallback={
				<MediaFailureCard
					activity={props.activity}
					blipComposer={props.blipComposer}
					canBlip={props.canBlip}
					title={mediaFailureTitle(props.media.status)}
					media={props.media}
					onEnableSelfMedia={props.onEnableSelfMedia}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
				/>
			}
		>
			<Match when={props.media.status === 'ready'}>
				<SelfMediaCard
					activity={props.activity}
					canBlip={props.canBlip}
					blipComposer={props.blipComposer}
					media={props.media}
					title="welcome to flop"
					actions={[
						{
							label: 'enable camera + mic',
							onPress: props.onEnableSelfMedia,
						},
					]}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
				>
					<p>
						Share the invite code, paste back the reply code, and send files
						device-to-device. Use the button below to turn on camera and
						microphone so other peers can see you.
					</p>
					{/* Future preflight? You'll get a quick mirror check before you go live. */}
				</SelfMediaCard>
			</Match>
			<Match when={props.media.status === 'requesting'}>
				<SelfMediaCard
					activity={props.activity}
					canBlip={props.canBlip}
					blipComposer={props.blipComposer}
					media={props.media}
					title="Allow camera + mic"
					actions={[{ label: 'waiting for permission', disabled: true }]}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
				>
					<p>
						The browser should be asking for permission now so this card can
						turn into your live portrait.
					</p>
				</SelfMediaCard>
			</Match>
			<Match when={props.media.status === 'live'}>
				<SelfMediaCard
					activity={props.activity}
					canBlip={props.canBlip}
					blipComposer={props.blipComposer}
					media={props.media}
					cameraToggle={{
						onPress: props.onToggleCamera,
						disabled: !props.media.cameraAvailable,
					}}
					microphoneToggle={{
						onPress: props.onToggleMicrophone,
						disabled: !props.media.microphoneAvailable,
					}}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
				/>
			</Match>
		</Switch>
	)
}
