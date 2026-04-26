import { For, Show } from 'solid-js'
import { BeforeUnloadGuard } from './before-unload-guard'
import { ConnectionCard } from './connection-card'
import { FileDropGuard } from './file-drop-guard'
import { PersonCard, Room } from './portraits'
import { createRoom, type RoomHandle } from './room'
import { SelfPortraitCard } from './self-portrait-card'
import type { PortraitFileState } from './state'
import './app.css'

function hasBusyFile(files: PortraitFileState[]) {
	return files.some(
		(file) => file.state === 'sending' || file.state === 'receiving',
	)
}

function hasBusyFiles(room: RoomHandle) {
	if (hasBusyFile(room.selfActivity().files)) return true

	return room.peerKeys().some((key) => {
		const peer = room.participant(key)
		return peer != null && hasBusyFile(peer.activity.files)
	})
}

function shouldWarnBeforeUnload(room: RoomHandle) {
	const state = room.state
	const connection = state.connection
	// A refresh is cheap until a real peer, code, or file is on the line.
	return (
		(connection.side === 'guest' &&
			(connection.status === 'creating-reply' ||
				connection.status === 'reply-ready' ||
				connection.status === 'connected')) ||
		hasBusyFiles(room) ||
		room.peerKeys().some((key) => room.peer(key)?.state === 'live')
	)
}

export default function App() {
	const room = createRoom()
	const actions = room.actions
	const state = room.state

	return (
		<>
			<BeforeUnloadGuard when={shouldWarnBeforeUnload(room)} />
			<FileDropGuard onDropFiles={actions.sendFiles} />
			<Room themeSeed={state.themeSeed}>
				<SelfPortraitCard
					activity={room.selfActivity()}
					canBlip
					blipComposer={state.blipComposer}
					media={state.selfMedia}
					onSendBlip={actions.sendBlip}
					onEnableSelfMedia={actions.enableSelfMedia}
					onSetBlipText={actions.setBlipText}
					onToggleCamera={actions.toggleCamera}
					onToggleMicrophone={actions.toggleMicrophone}
				/>
				<For each={room.peerKeys()}>
					{(key) => (
						<Show when={room.peer(key)}>
							{(peer) => (
								<PersonCard
									activity={peer().activity}
									colorSeed={peer().id}
									mediaState={peer().mediaState}
									mediaStream={peer().mediaStream}
									state={peer().state}
								/>
							)}
						</Show>
					)}
				</For>
				{/* Once connected, the strip should be people-first. Re-inviting is a host affordance, not the main event. */}
				<Show
					when={
						!(
							state.connection.side === 'guest' &&
							state.connection.status === 'connected'
						)
					}
				>
					<ConnectionCard
						connection={state.connection}
						hasPeers={room.peerKeys().length > 0}
						onAcceptReply={actions.acceptReply}
						onBecomeGuest={actions.becomeGuest}
						onBecomeHost={actions.becomeHost}
						onCopyInviteLink={actions.copyInviteLink}
						onCopyReplyCode={actions.copyReplyCode}
						onCreateReply={actions.createReply}
						onSetInviteText={actions.setInviteText}
						onSetReplyText={actions.setReplyText}
					/>
				</Show>
			</Room>
		</>
	)
}
