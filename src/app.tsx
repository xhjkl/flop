import { For, Show } from 'solid-js'
import { BeforeUnloadGuard } from './before-unload-guard'
import { FileDropGuard } from './file-drop-guard'
import { createRoom, type RoomState } from './room'
import { ConnectionCard, SelfPortraitCard } from './room-cards'
import { PersonCard, Room } from './room-ui'
import './app.css'

function hasBusyFiles(state: RoomState) {
	const selfBusy = state.selfActivity.files.some(
		(file) => file.state === 'sending' || file.state === 'receiving',
	)
	const peerBusy = state.peers.some((peer) =>
		peer.activity.files.some(
			(file) => file.state === 'sending' || file.state === 'receiving',
		),
	)

	return selfBusy || peerBusy
}

function shouldWarnBeforeUnload(state: RoomState) {
	const phase = state.connection.phase
	// A refresh is cheap until a real peer, code, or file is on the line.
	return (
		phase === 'creating-reply' ||
		phase === 'reply-ready' ||
		phase === 'connected' ||
		hasBusyFiles(state) ||
		state.peers.some((peer) => peer.state === 'live')
	)
}

export default function App() {
	const room = createRoom()
	const state = room.state

	return (
		<>
			<BeforeUnloadGuard when={shouldWarnBeforeUnload(state)} />
			<FileDropGuard onDropFiles={room.sendFiles} />
			<Room themeSeed={state.themeSeed}>
				<SelfPortraitCard
					activity={state.selfActivity}
					canBlip
					blipComposer={state.blipComposer}
					media={state.selfMedia}
					onSendBlip={room.sendBlip}
					onEnableSelfMedia={room.enableSelfMedia}
					onSetBlipText={room.setBlipText}
					onToggleCamera={room.toggleCamera}
					onToggleMicrophone={room.toggleMicrophone}
				/>
				<For each={state.peers}>
					{(peer) => (
						<PersonCard
							activity={peer.activity}
							colorSeed={peer.colorSeed}
							mediaStream={peer.mediaStream}
							name={peer.name}
							state={peer.state}
						/>
					)}
				</For>
				{/* Once connected, the strip should be people-first. Re-inviting is a host affordance, not the main event. */}
				<Show when={state.connection.phase !== 'connected'}>
					<ConnectionCard
						connection={state.connection}
						hasPeers={state.peers.length > 0}
						onAcceptReply={room.acceptReply}
						onBecomeGuest={room.becomeGuest}
						onBecomeHost={room.becomeHost}
						onCopyInviteLink={room.copyInviteLink}
						onCopyReplyCode={room.copyReplyCode}
						onCreateReply={room.createReply}
						onSetInviteText={room.setInviteText}
						onSetReplyText={room.setReplyText}
					/>
				</Show>
			</Room>
		</>
	)
}
