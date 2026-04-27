import { For, Show } from 'solid-js'
import { ConnectionCard, type HostInviteMode } from './connection-card'
import { PersonCard, Room } from './portraits'
import type { RoomHandle } from './room'
import { SelfPortraitCard } from './self-portrait-card'

export type RoomViewProps = {
	room: RoomHandle
	hostInviteMode?: HostInviteMode
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
			<Show
				when={
					props.room.state.connection.side !== 'guest' ||
					props.room.state.connection.status !== 'connected'
				}
			>
				<ConnectionCard
					connection={props.room.state.connection}
					canJoinExistingRoom={
						props.room.state.connection.side !== 'host' ||
						props.room.peers().length === 0
					}
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
