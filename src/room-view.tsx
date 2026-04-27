import { For, Show } from 'solid-js'
import { ConnectionCard, type HostInviteMode } from './connection-card'
import { PersonCard, Room } from './portraits'
import type { RoomPeer, RoomState } from './room'
import { SelfPortraitCard } from './self-portrait-card'
import type { ConnectionState, PortraitActivityState } from './state'

type RoomViewActions = {
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

type RoomViewRoom = {
	actions: RoomViewActions
	peers: () => RoomPeer[]
	selfActivity: () => PortraitActivityState
	state: RoomState
}

export type RoomViewProps = {
	room: RoomViewRoom
	hostInviteMode?: HostInviteMode
}

const shouldShowConnection = (connection: ConnectionState) => {
	return !(connection.side === 'guest' && connection.status === 'connected')
}

const canJoinExistingRoom = (
	connection: ConnectionState,
	peerCount: number,
) => {
	return connection.side !== 'host' || peerCount === 0
}

export const RoomView = (props: RoomViewProps) => {
	return (
		<Room themeSeed={props.room.state.themeSeed}>
			<SelfPortraitCard
				activity={props.room.selfActivity()}
				blipComposer={props.room.state.blipComposer}
				media={props.room.state.selfMedia}
				onSendBlip={props.room.actions.sendBlip}
				onEnableSelfMedia={props.room.actions.enableSelfMedia}
				onSetBlipText={props.room.actions.setBlipText}
				onToggleCamera={props.room.actions.toggleCamera}
				onToggleMicrophone={props.room.actions.toggleMicrophone}
			/>
			<For each={props.room.peers()}>
				{(peer) => (
					<PersonCard
						activity={peer.activity}
						colorSeed={peer.id}
						mediaState={peer.mediaState}
						mediaStream={peer.mediaStream}
						state={peer.state}
					/>
				)}
			</For>
			<Show when={shouldShowConnection(props.room.state.connection)}>
				<ConnectionCard
					connection={props.room.state.connection}
					canJoinExistingRoom={canJoinExistingRoom(
						props.room.state.connection,
						props.room.peers().length,
					)}
					initialHostInviteMode={props.hostInviteMode}
					onAcceptReply={props.room.actions.acceptReply}
					onBecomeGuest={props.room.actions.becomeGuest}
					onBecomeHost={props.room.actions.becomeHost}
					onCopyAutoInviteLink={props.room.actions.copyAutoInviteLink}
					onCopyManualInviteLink={props.room.actions.copyManualInviteLink}
					onCopyReplyCode={props.room.actions.copyReplyCode}
					onCreateReply={props.room.actions.createReply}
					onSetInviteText={props.room.actions.setInviteText}
					onSetReplyText={props.room.actions.setReplyText}
				/>
			</Show>
		</Room>
	)
}
