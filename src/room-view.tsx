import { For, Show } from 'solid-js'
import { ConnectionCard, type HostInviteMode } from './connection-card'
import { PersonCard, Room } from './portraits'
import type { SelfMedia } from './self-media'
import { SelfPortraitCard } from './self-portrait-card'
import type {
	BlipComposerState,
	ConnectionState,
	PeerMediaState,
	PeerState,
	PortraitActivityState,
} from './state'

export type RoomViewPeer = {
	activity: PortraitActivityState
	colorSeed: string
	mediaState?: PeerMediaState | null
	mediaStream?: MediaStream | null
	state: PeerState
}

export type RoomViewActions = {
	acceptReply: (replyText?: string) => void
	becomeGuest: () => void
	becomeHost: () => void
	copyAutoInviteLink: () => void
	copyManualInviteLink: () => void
	copyReplyCode: () => void
	createReply: (inviteText?: string) => void
	enableSelfMedia: () => void
	sendBlip: () => void
	setBlipText: (text: string) => void
	setInviteText: (inviteText: string) => void
	setReplyText: (replyText: string) => void
	toggleCamera: () => void
	toggleMicrophone: () => void
}

export type RoomViewProps = {
	actions: RoomViewActions
	blipComposer: BlipComposerState
	canBlip?: boolean
	connection: ConnectionState
	hostInviteMode?: HostInviteMode
	peers?: RoomViewPeer[]
	selfActivity: PortraitActivityState
	selfMedia: SelfMedia
	themeSeed: string
}

const shouldShowConnection = (connection: ConnectionState) => {
	return !(connection.side === 'guest' && connection.status === 'connected')
}

const canJoinExistingRoom = (
	connection: ConnectionState,
	peers: RoomViewPeer[],
) => {
	return connection.side !== 'host' || peers.length === 0
}

export const RoomView = (props: RoomViewProps) => {
	const peers = () => props.peers ?? []

	return (
		<Room themeSeed={props.themeSeed}>
			<SelfPortraitCard
				activity={props.selfActivity}
				canBlip={props.canBlip ?? true}
				blipComposer={props.blipComposer}
				media={props.selfMedia}
				onSendBlip={props.actions.sendBlip}
				onEnableSelfMedia={props.actions.enableSelfMedia}
				onSetBlipText={props.actions.setBlipText}
				onToggleCamera={props.actions.toggleCamera}
				onToggleMicrophone={props.actions.toggleMicrophone}
			/>
			<For each={peers()}>
				{(peer) => (
					<PersonCard
						activity={peer.activity}
						colorSeed={peer.colorSeed}
						mediaState={peer.mediaState}
						mediaStream={peer.mediaStream}
						state={peer.state}
					/>
				)}
			</For>
			<Show when={shouldShowConnection(props.connection)}>
				<ConnectionCard
					connection={props.connection}
					canJoinExistingRoom={canJoinExistingRoom(props.connection, peers())}
					initialHostInviteMode={props.hostInviteMode}
					onAcceptReply={props.actions.acceptReply}
					onBecomeGuest={props.actions.becomeGuest}
					onBecomeHost={props.actions.becomeHost}
					onCopyAutoInviteLink={props.actions.copyAutoInviteLink}
					onCopyManualInviteLink={props.actions.copyManualInviteLink}
					onCopyReplyCode={props.actions.copyReplyCode}
					onCreateReply={props.actions.createReply}
					onSetInviteText={props.actions.setInviteText}
					onSetReplyText={props.actions.setReplyText}
				/>
			</Show>
		</Room>
	)
}
