import { For, Show } from 'solid-js'
import { BeforeUnloadGuard } from './before-unload-guard'
import { ConnectionCard } from './connection-card'
import { FileDropGuard } from './file-drop-guard'
import { PersonCard, Room } from './portraits'
import { createRoom, type RoomLogic } from './room'
import { SelfPortraitCard } from './self-portrait-card'
import type { PortraitFileState } from './state'
import './app.css'

function hasBusyFile(files: PortraitFileState[]) {
	return files.some(
		(file) => file.state === 'sending' || file.state === 'receiving',
	)
}

function hasBusyFiles(room: RoomLogic) {
	if (hasBusyFile(room.selfActivity().files)) return true

	return room.peerKeys().some((key) => {
		const peer = room.participant(key)
		return peer != null && hasBusyFile(peer.activity.files)
	})
}

function shouldWarnBeforeUnload(room: RoomLogic) {
	const state = room.state
	const phase = state.connection.phase
	// A refresh is cheap until a real peer, code, or file is on the line.
	return (
		phase === 'creating-reply' ||
		phase === 'reply-ready' ||
		phase === 'connected' ||
		hasBusyFiles(room) ||
		room.peerKeys().some((key) => room.participant(key)?.state === 'live')
	)
}

export default function App() {
	const room = createRoom()
	const state = room.state

	return (
		<>
			<BeforeUnloadGuard when={shouldWarnBeforeUnload(room)} />
			<FileDropGuard onDropFiles={room.sendFiles} />
			<Room themeSeed={state.themeSeed}>
				<SelfPortraitCard
					activity={room.selfActivity()}
					canBlip
					blipComposer={state.blipComposer}
					media={state.selfMedia}
					onSendBlip={room.sendBlip}
					onEnableSelfMedia={room.enableSelfMedia}
					onSetBlipText={room.setBlipText}
					onToggleCamera={room.toggleCamera}
					onToggleMicrophone={room.toggleMicrophone}
				/>
				<For each={room.peerKeys()}>
					{(key) => (
						<Show when={room.participant(key)}>
							{(peer) => (
								<PersonCard
									activity={peer().activity}
									colorSeed={peer().id}
									mediaStream={peer().mediaStream}
									mediaVersion={peer().mediaVersion}
									state={peer().state}
								/>
							)}
						</Show>
					)}
				</For>
				{/* Once connected, the strip should be people-first. Re-inviting is a host affordance, not the main event. */}
				<Show when={state.connection.phase !== 'connected'}>
					<ConnectionCard
						connection={state.connection}
						hasPeers={room.peerKeys().length > 0}
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
