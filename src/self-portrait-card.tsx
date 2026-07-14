import { Match, Switch } from 'solid-js'
import { SelfMediaCard } from './portraits'
import type { BlipComposerState } from './room/activity/blip'
import type { ParticipantActivity } from './room/participant'
import type { SelfMedia, SelfMediaStatus } from './self-media'

const mediaFailureTitle = (status: SelfMediaStatus) => {
	switch (status) {
		case 'denied':
			return 'Access denied'
		case 'missing':
			return 'No devices found'
		case 'unsupported':
			return 'Browser unsupported'
		default:
			return 'Could not start media'
	}
}

type SelfPortraitCardProps = {
	activity: ParticipantActivity
	blipComposer: BlipComposerState
	media: SelfMedia
	onDismissBlipIssue: () => void
	onSendBlip: () => void
	onEnableSelfMedia: () => void
	onSetBlipText: (text: string) => void
	onToggleCamera: () => void
	onToggleMicrophone: () => void
	onToggleScreen: () => void
}

export const SelfPortraitCard = (props: SelfPortraitCardProps) => {
	const noticeCardProps = () => ({
		activity: props.activity,
		blipComposer: props.blipComposer,
		canBlip: true,
		media: props.media,
		onDismissBlipIssue: props.onDismissBlipIssue,
		onSendBlip: props.onSendBlip,
		onSetBlipText: props.onSetBlipText,
		onToggleScreen: props.onToggleScreen,
	})

	return (
		// Welcome and permission are one portrait so the first step never feels like a modal.
		<Switch
			fallback={
				<SelfMediaCard
					{...noticeCardProps()}
					title={mediaFailureTitle(props.media.status)}
					actions={
						<button type="button" onClick={props.onEnableSelfMedia}>
							try again
						</button>
					}
				>
					<p>
						{props.media.issue ??
							'This browser could not open camera and microphone.'}
					</p>
					<p>
						After changing your browser or device setting, try again. You can
						still use the room without camera or microphone.
					</p>
				</SelfMediaCard>
			}
		>
			<Match when={props.media.status === 'ready'}>
				<SelfMediaCard
					{...noticeCardProps()}
					title="welcome to flop"
					actions={
						<button type="button" onClick={props.onEnableSelfMedia}>
							enable cam and mic
						</button>
					}
				>
					<p>
						Send an invite to another device. Once connected, drop files here to
						send them directly. Turn on camera and microphone when you want
						peers to see or hear you.
					</p>
					{/* Future preflight? You'll get a quick mirror check before you go live. */}
				</SelfMediaCard>
			</Match>
			<Match when={props.media.status === 'requesting'}>
				<SelfMediaCard
					{...noticeCardProps()}
					title="Allow cam and mic"
					actions={
						<button type="button" disabled>
							waiting for permission
						</button>
					}
				>
					<p>
						Your browser should be asking for permission now. Once allowed, this
						card becomes your live portrait.
					</p>
				</SelfMediaCard>
			</Match>
			<Match when={props.media.status === 'live'}>
				<SelfMediaCard
					activity={props.activity}
					canBlip
					blipComposer={props.blipComposer}
					media={props.media}
					onSendBlip={props.onSendBlip}
					onDismissBlipIssue={props.onDismissBlipIssue}
					onSetBlipText={props.onSetBlipText}
					onToggleCamera={props.onToggleCamera}
					onToggleMicrophone={props.onToggleMicrophone}
					onToggleScreen={props.onToggleScreen}
				/>
			</Match>
		</Switch>
	)
}
