import { Match, Switch } from 'solid-js'
import { SelfMediaCard } from './portraits'
import type { SelfMedia, SelfMediaStatus } from './self-media'
import type { BlipComposerState, PortraitActivityState } from './state'

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

export const SelfPortraitCard = (props: {
	activity: PortraitActivityState
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
				<SelfMediaCard
					activity={props.activity}
					blipComposer={props.blipComposer}
					canBlip
					media={props.media}
					title={mediaFailureTitle(props.media.status)}
					actions={
						<button type="button" onClick={props.onEnableSelfMedia}>
							try again
						</button>
					}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
				>
					<p>
						{props.media.issue ??
							'The browser could not open the camera and microphone.'}
					</p>
					<p>
						After changing the browser or device setting, try again. You can
						still use the room without camera or microphone.
					</p>
				</SelfMediaCard>
			}
		>
			<Match when={props.media.status === 'ready'}>
				<SelfMediaCard
					activity={props.activity}
					canBlip
					blipComposer={props.blipComposer}
					media={props.media}
					title="welcome to flop"
					actions={
						<button type="button" onClick={props.onEnableSelfMedia}>
							enable cam and mic
						</button>
					}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
				>
					<p>
						Send an invite to the other device. Once you are connected, drop
						files here to send them directly. Turn on camera and microphone when
						you want other peers to see or hear you.
					</p>
					{/* Future preflight? You'll get a quick mirror check before you go live. */}
				</SelfMediaCard>
			</Match>
			<Match when={props.media.status === 'requesting'}>
				<SelfMediaCard
					activity={props.activity}
					canBlip
					blipComposer={props.blipComposer}
					media={props.media}
					title="Allow cam and mic"
					actions={
						<button type="button" disabled>
							waiting for permission
						</button>
					}
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
					canBlip
					blipComposer={props.blipComposer}
					media={props.media}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
					onToggleCamera={props.onToggleCamera}
					onToggleMicrophone={props.onToggleMicrophone}
				/>
			</Match>
		</Switch>
	)
}
