import { For, Show } from 'solid-js'
import { ConnectionCard, type HostInviteMode } from './connection-card'
import { Daisy } from './daisy'
import { PersonCard, Room } from './portraits'
import type { RoomHandle } from './room'
import { SelfPortraitCard } from './self-portrait-card'
import type { RelayMetering } from './state'

export type RoomViewProps = {
	room: RoomHandle
	hostInviteMode?: HostInviteMode
}

const RELAY_BYTES_PER_GIGABYTE = 1_000_000_000
const RELAY_MAX_BYTES = 2 * RELAY_BYTES_PER_GIGABYTE
const RELAY_MAX_SECONDS = 60 * 60

const relayMinutesLeft = (secondsLeft: number) => {
	return Math.ceil(Math.max(0, secondsLeft) / 60)
}

const relayGigabytesLeft = (bytesLeft: number) => {
	const gigabytes = Math.max(0, bytesLeft) / RELAY_BYTES_PER_GIGABYTE
	if (gigabytes >= 1) return gigabytes.toFixed(gigabytes % 1 === 0 ? 0 : 1)

	return gigabytes.toFixed(1)
}

const RelayMeter = (props: {
	label: string
	max: number
	text: string
	value: number
}) => {
	return (
		<div class="relay-meter">
			<Daisy
				ariaLabel={`${props.text} ${props.label} left`}
				max={props.max}
				text={props.text}
				value={props.value}
			/>
			<span>{props.label}</span>
		</div>
	)
}

const RelayNoticeCard = (props: { metering: RelayMetering }) => {
	const minutesLeft = () => relayMinutesLeft(props.metering.secondsLeft)
	const gigabytesLeft = () => relayGigabytesLeft(props.metering.bytesLeft)

	return (
		<aside
			class="portrait-card utility-card relay-notice-card"
			aria-label="relay notice"
		>
			<header class="utility-header">
				<strong>room traffic uses a public relay</strong>
			</header>
			<p>
				To keep Flop free for everyone, relayed rooms are time-limited. For
				longer calls, reconnect from a network that can reach peers directly.
			</p>
			<div class="relay-meters">
				<RelayMeter
					label="min"
					max={RELAY_MAX_SECONDS / 60}
					text={`${minutesLeft()}`}
					value={minutesLeft()}
				/>
				<RelayMeter
					label="gb"
					max={RELAY_MAX_BYTES}
					text={gigabytesLeft()}
					value={props.metering.bytesLeft}
				/>
			</div>
		</aside>
	)
}

export const RoomView = (props: RoomViewProps) => {
	return (
		<Room themeSeed={props.room.state.themeSeed}>
			<SelfPortraitCard
				activity={props.room.selfActivity()}
				blipComposer={props.room.state.blipComposer}
				media={props.room.state.selfMedia}
				onSendBlip={props.room.actions.sendBlip}
				onDismissBlipIssue={props.room.actions.dismissBlipIssue}
				onEnableSelfMedia={props.room.actions.enableSelfMedia}
				onSetBlipText={props.room.actions.setBlipText}
				onToggleCamera={props.room.actions.toggleCamera}
				onToggleMicrophone={props.room.actions.toggleMicrophone}
				onToggleScreen={props.room.actions.toggleScreen}
			/>
			<For each={props.room.peers()}>
				{(peer) => (
					<PersonCard
						activity={peer.activity}
						colorSeed={peer.id}
						mediaState={peer.mediaState}
						mediaStream={peer.mediaStream}
						connectionState={peer.connectionState}
					/>
				)}
			</For>
			<Show when={props.room.state.relayMetering}>
				{(metering) => <RelayNoticeCard metering={metering()} />}
			</Show>
			<Show
				when={
					props.room.state.connection.side !== 'guest' ||
					props.room.state.connection.status !== 'connected'
				}
			>
				<ConnectionCard
					connection={props.room.state.connection}
					canClaimFindingInviteLink={props.room.canClaimFindingInviteLink()}
					canJoinExistingRoom={
						props.room.state.connection.side !== 'host' ||
						props.room.peers().length === 0
					}
					initialHostInviteMode={props.hostInviteMode}
					onAcceptReply={props.room.actions.acceptReply}
					onBecomeGuest={props.room.actions.becomeGuest}
					onBecomeHost={props.room.actions.becomeHost}
					onClaimInviteLinkAsHost={props.room.actions.claimInviteLinkAsHost}
					onCopyInviteLink={props.room.actions.copyInviteLink}
					onCopyInviteCode={props.room.actions.copyInviteCode}
					onCopyReplyCode={props.room.actions.copyReplyCode}
					onCreateReply={props.room.actions.createReply}
					onSetInviteText={props.room.actions.setInviteText}
					onSetReplyText={props.room.actions.setReplyText}
				/>
			</Show>
		</Room>
	)
}
