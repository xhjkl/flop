import { For, Show } from 'solid-js'
import { RELAY_GRANT_BYTES, RELAY_GRANT_SECONDS } from '../../contracts/relay'
import { ConnectionCard } from '../connection-card'
import { Daisy } from '../daisy'
import { PeerPortraitCard, PortraitStrip, SelfPortraitCard } from '../portraits'
import type { RoomController } from '../room'
import type { RelayMetering } from '../room/relay'

export type RoomViewProps = {
	room: RoomController
}

const RELAY_BYTES_PER_GIGABYTE = 1_000_000_000

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
					max={RELAY_GRANT_SECONDS}
					text={`${minutesLeft()}`}
					value={props.metering.secondsLeft}
				/>
				<RelayMeter
					label="gb"
					max={RELAY_GRANT_BYTES}
					text={gigabytesLeft()}
					value={props.metering.bytesLeft}
				/>
			</div>
		</aside>
	)
}

export const RoomView = (props: RoomViewProps) => {
	return (
		<PortraitStrip themeSeed={props.room.state.themeSeed}>
			<SelfPortraitCard
				blipDraft={props.room.self.blipDraft}
				fileTransferIssue={props.room.self.fileTransferIssue}
				files={props.room.self.files}
				media={props.room.self.media}
				onSendBlip={props.room.commands.sendBlip}
				onDismissFileTransferIssue={
					props.room.commands.dismissFileTransferIssue
				}
				onEnableSelfMedia={props.room.commands.enableSelfMedia}
				onSendFiles={props.room.commands.sendFiles}
				onSetBlipDraft={props.room.commands.setBlipDraft}
				onToggleCamera={props.room.commands.toggleCamera}
				onToggleMicrophone={props.room.commands.toggleMicrophone}
				onToggleScreen={props.room.commands.toggleScreen}
			/>
			{/* Stable participant records survive every transport replacement. */}
			<For each={props.room.peers.all()}>
				{(peer) => <PeerPortraitCard peer={peer} />}
			</For>
			<Show when={props.room.state.relayMetering}>
				{(metering) => <RelayNoticeCard metering={metering()} />}
			</Show>
			<Show
				when={
					props.room.state.entry.side !== 'guest' ||
					props.room.state.entry.status !== 'connected'
				}
			>
				<ConnectionCard
					entry={props.room.state.entry}
					canClaimInviteAsHost={props.room.canClaimInviteAsHost()}
					canBecomeGuest={
						props.room.state.entry.side !== 'host' ||
						props.room.peers.all().length === 0
					}
					onAcceptReplyCode={props.room.commands.acceptReplyCode}
					onBecomeGuest={props.room.commands.becomeGuest}
					onBecomeHost={props.room.commands.becomeHost}
					onClaimInviteLinkAsHost={props.room.commands.claimInviteLinkAsHost}
					onJoinInvite={props.room.commands.joinInvite}
					onSetInviteText={props.room.commands.setInviteText}
					onSetReplyText={props.room.commands.setReplyText}
					onTryRelay={props.room.commands.tryRelay}
				/>
			</Show>
		</PortraitStrip>
	)
}
