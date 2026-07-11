import {
	createMemo,
	createSignal,
	type JSX,
	Match,
	Show,
	Switch,
} from 'solid-js'
import { Daisy } from './daisy'
import { canShareText, shareText } from './room/invite'
import { RELAY_FALLBACK_WAIT_SECONDS } from './room/relay'
import { statusCopy } from './room/status-copy'
import {
	type ConnectionState,
	type GuestConnectionState,
	guestFindingLinkConnection,
	type HostConnectionState,
} from './state'
import { createPulse } from './ui/pulse'
import { QrCodeImage } from './ui/qr'
import { encodeQrCode } from './ui/qr-code'

export type HostInviteMode = 'code' | 'link'

const ConnectionActionRail = (props: { children: JSX.Element }) => {
	return (
		<div class="card-actions connection-side-switch connection-action">
			{props.children}
		</div>
	)
}

const ShareTextBlock = (props: {
	label: string
	value: string
	placeholder: string
	copyLabel: string
	shareLabel?: string
	disabled?: boolean
	onCopy?: () => void
	qr?: boolean
}) => {
	const copied = createPulse(1400)
	const empty = () => props.value.trim() === ''
	const canShare = () => !empty() && canShareText(props.value)
	const qr = createMemo(() =>
		(props.qr ?? false) && !empty() ? encodeQrCode(props.value) : null,
	)
	const actionLabel = () => {
		if (copied.active()) return 'copied'
		if (canShare()) return props.shareLabel ?? 'share'
		return props.copyLabel
	}

	const press = () => {
		if (canShare()) {
			void shareText(props.value)
			return
		}

		props.onCopy?.()
		copied.trigger()
	}

	return (
		<div class="connection-copy-block" classList={{ 'is-empty': empty() }}>
			<div class="connection-copy-head">
				<Show when={qr()} fallback={<span>{props.label}</span>}>
					<pre class="connection-copy-inline-value scrollbarless">
						{props.value}
					</pre>
				</Show>
				<button
					type="button"
					class="connection-copy-button"
					onClick={press}
					disabled={empty() || (props.disabled ?? false)}
					classList={{ 'is-copied': copied.active() }}
				>
					{actionLabel()}
				</button>
			</div>
			<div class="connection-copy-body">
				<Show
					when={qr()}
					fallback={
						<pre class="connection-copy-value scrollbarless">
							{empty() ? props.placeholder : props.value}
						</pre>
					}
				>
					{(code) => <QrCodeImage code={code()} />}
				</Show>
			</div>
		</div>
	)
}

const PasteLine = (props: {
	label: string
	value: string
	placeholder: string
	disabled?: boolean
	onChange: (text: string) => void
	onSubmit: (text?: string) => void
}) => {
	const submit = (text?: string) => {
		if ((text ?? props.value).trim() === '') return
		props.onSubmit(text)
	}

	const submitPaste = (event: ClipboardEvent) => {
		const text = event.clipboardData?.getData('text') ?? ''
		if (text.trim() === '') return

		// Paste is the happy path. Enter is just there for people who type anyway.
		event.preventDefault()
		submit(text)
	}

	const submitEnter = (event: KeyboardEvent) => {
		if (event.key !== 'Enter') return
		event.preventDefault()
		submit()
	}

	return (
		<label class="connection-paste-line">
			<span>{props.label}</span>
			<input
				type="text"
				value={props.value}
				placeholder={props.placeholder}
				onInput={(event) => props.onChange(event.currentTarget.value)}
				onPaste={submitPaste}
				onKeyDown={submitEnter}
				disabled={props.disabled ?? false}
			/>
		</label>
	)
}

const HostInvitePane = (props: {
	connection: HostConnectionState
	canJoinExistingRoom: boolean
	mode: HostInviteMode
	onAcceptReply: (replyText?: string) => void
	onBecomeGuest: () => void
	onCopyInviteLink: () => void
	onCopyInviteCode: () => void
	onSetReplyText: (replyText: string) => void
}) => {
	const busy = () =>
		props.connection.status === 'creating-invite' ||
		props.connection.status === 'accepting-reply'
	const inviteLinkReady = () => props.connection.inviteLinkStatus === 'ready'

	return (
		<div
			class="connection-mode-frame connection-body"
			classList={{ 'is-code': props.mode === 'code' }}
		>
			<div class="connection-mode-rail">
				<div
					class="connection-mode-pane"
					aria-hidden={props.mode === 'link' ? 'false' : 'true'}
				>
					<div class="connection-copy">
						<Show
							when={inviteLinkReady()}
							fallback={
								<p>
									Preparing an invite link. When it is ready, send it to another
									device.
								</p>
							}
						>
							<p>
								Send this invite link to another device. If it works, they will
								appear here automatically.
							</p>
						</Show>
						<Show when={props.connection.inviteLinkStatus === 'failed'}>
							<p class="connection-issue">{statusCopy.hostInviteLinkFailed}</p>
						</Show>
					</div>
					<div class="connection-main">
						<ShareTextBlock
							label="invite link"
							value={inviteLinkReady() ? props.connection.inviteLink : ''}
							placeholder={
								props.connection.inviteLinkStatus === 'failed'
									? 'invite link is unavailable'
									: 'preparing invite link'
							}
							copyLabel={inviteLinkReady() ? 'copy link' : 'preparing'}
							shareLabel="share link"
							disabled={!inviteLinkReady()}
							onCopy={props.onCopyInviteLink}
							qr={inviteLinkReady()}
						/>
					</div>
				</div>
				<div
					class="connection-mode-pane"
					aria-hidden={props.mode === 'code' ? 'false' : 'true'}
				>
					{/* Manual host flow: send one invite out, paste one reply code back, admit one guest. */}
					<div class="connection-copy">
						<p>
							Use this invite code if the link does not bring them in. Send it,
							then paste their reply code here.
						</p>
						<Show when={props.connection.issue}>
							{(issue) => <p class="connection-issue">{issue()}</p>}
						</Show>
					</div>
					<div class="connection-main">
						<ShareTextBlock
							label="invite code"
							value={props.connection.inviteCode}
							placeholder="invite code is being created"
							copyLabel="copy invite code"
							shareLabel="share invite code"
							disabled={props.mode !== 'code'}
							onCopy={props.onCopyInviteCode}
							qr
						/>
						<PasteLine
							label="paste their reply code here to let them in"
							value={props.connection.replyText}
							placeholder="paste reply code"
							disabled={busy() || props.mode !== 'code'}
							onChange={props.onSetReplyText}
							onSubmit={props.onAcceptReply}
						/>
					</div>
					<Show when={props.canJoinExistingRoom}>
						<ConnectionActionRail>
							<button type="button" onClick={props.onBecomeGuest}>
								join someone else instead
							</button>
						</ConnectionActionRail>
					</Show>
				</div>
			</div>
		</div>
	)
}

const GuestInvitePane = (props: {
	canClaimFindingInviteLink: boolean
	connection: GuestConnectionState
	onBecomeHost: () => void
	onClaimInviteLinkAsHost: () => void
	onCopyReplyCode: () => void
	onCreateReply: (inviteText?: string) => void
	onSetInviteText: (inviteText: string) => void
	onTryRelay: () => void
}) => {
	const creating = () => props.connection.status === 'creating-reply'
	const hasInviteField = () => props.connection.status !== 'finding-link'
	const canCreate = () =>
		creating() || props.connection.inviteText.trim() !== ''
	const canClaimFindingLink = () =>
		props.canClaimFindingInviteLink &&
		props.connection.status === 'finding-link' &&
		props.connection.issue == null &&
		props.connection.inviteLinkPresence?.hosts === 0

	return (
		<>
			{/* Guest flow: consume one invite, produce one reply code, then wait for the host to admit it. */}
			<Switch>
				<Match
					when={
						props.connection.status === 'needs-invite' ||
						props.connection.status === 'creating-reply' ||
						props.connection.status === 'finding-link'
					}
				>
					<div
						class="connection-main connection-body"
						classList={{
							'is-field': hasInviteField(),
						}}
					>
						<Show
							when={props.connection.status !== 'finding-link'}
							fallback={
								<ShareTextBlock
									label="invite link"
									value={props.connection.inviteText}
									placeholder="finding host"
									copyLabel="waiting"
									disabled
								/>
							}
						>
							<PasteLine
								label="paste invite link or invite code to create a reply code"
								value={props.connection.inviteText}
								placeholder="paste invite link or invite code"
								disabled={creating()}
								onChange={props.onSetInviteText}
								onSubmit={props.onCreateReply}
							/>
						</Show>
					</div>
					<Show when={hasInviteField()}>
						<div class="card-actions connection-action">
							<button
								type="button"
								onClick={() => props.onCreateReply()}
								disabled={!canCreate()}
							>
								{creating() ? 'creating reply code' : 'create reply code'}
							</button>
						</div>
					</Show>
					<Show when={canClaimFindingLink()}>
						<div class="card-actions connection-action">
							<button type="button" onClick={props.onClaimInviteLinkAsHost}>
								host this link
							</button>
						</div>
					</Show>
				</Match>
				<Match when={props.connection.status === 'reply-ready'}>
					<div class="connection-main connection-body">
						<ShareTextBlock
							label="reply code"
							value={props.connection.replyCode}
							placeholder="reply code appears here"
							copyLabel="copy reply code"
							shareLabel="share reply code"
							onCopy={props.onCopyReplyCode}
							qr
						/>
					</div>
				</Match>
			</Switch>
			<Show
				when={
					props.connection.status !== 'connected' &&
					props.connection.status !== 'finding-link'
				}
			>
				<ConnectionActionRail>
					<button type="button" onClick={props.onBecomeHost}>
						start a room instead
					</button>
				</ConnectionActionRail>
			</Show>
		</>
	)
}

const relayWaitSeconds = (seconds: number) => {
	return Math.max(0, Math.min(RELAY_FALLBACK_WAIT_SECONDS, seconds))
}

const FindingRelayControl = (props: {
	secondsLeft: number
	onTryRelay: () => void
}) => {
	const secondsLeft = () => relayWaitSeconds(props.secondsLeft)

	return (
		<Show
			when={secondsLeft() <= 0}
			fallback={
				<Daisy
					max={RELAY_FALLBACK_WAIT_SECONDS}
					text={`${Math.ceil(secondsLeft())}`}
					value={secondsLeft()}
				/>
			}
		>
			<button
				type="button"
				class="connection-relay-button"
				onClick={props.onTryRelay}
			>
				try relay
			</button>
		</Show>
	)
}

export const ConnectionCard = (props: {
	connection: ConnectionState
	canClaimFindingInviteLink: boolean
	canJoinExistingRoom: boolean
	initialHostInviteMode: HostInviteMode | null
	onAcceptReply: (replyText?: string) => void
	onBecomeGuest: () => void
	onBecomeHost: () => void
	onClaimInviteLinkAsHost: () => void
	onCopyInviteLink: () => void
	onCopyInviteCode: () => void
	onCopyReplyCode: () => void
	onCreateReply: (inviteText?: string) => void
	onSetInviteText: (inviteText: string) => void
	onSetReplyText: (replyText: string) => void
	onTryRelay: () => void
}) => {
	const hostConnection = () =>
		props.connection.side === 'host' ? props.connection : null
	const guestConnection = () =>
		props.connection.side === 'guest' ? props.connection : null
	const findingLinkConnection = () => {
		const connection = guestConnection()
		return connection == null ? null : guestFindingLinkConnection(connection)
	}
	const findingLinkHosts = () => {
		return findingLinkConnection()?.inviteLinkPresence?.hosts ?? null
	}
	const hasFindingLinkHost = () => (findingLinkHosts() ?? 0) > 0
	const hasClaimableFindingLink = () => {
		const connection = findingLinkConnection()
		return (
			props.canClaimFindingInviteLink &&
			connection != null &&
			connection.issue == null &&
			connection.inviteLinkPresence?.hosts === 0
		)
	}
	const hasReachableFindingLinkHost = () => {
		const connection = guestConnection()
		return connection?.issue == null && hasFindingLinkHost()
	}
	const findingRelaySecondsLeft = () => {
		const connection = findingLinkConnection()
		if (connection == null) return null
		if (!hasReachableFindingLinkHost()) return null

		return connection.relayFallbackSecondsLeft
	}
	const hasFindingRelayControl = () => findingRelaySecondsLeft() != null
	const hasConnectionCopy = () =>
		props.connection.side !== 'host' && !hasFindingRelayControl()
	const hasConnectionEntryLayout = () => {
		const connection = guestConnection()
		return (
			connection?.status === 'needs-invite' ||
			connection?.status === 'creating-reply'
		)
	}
	const [hostInviteMode, setHostInviteMode] = createSignal<HostInviteMode>(
		props.initialHostInviteMode ?? 'link',
	)

	return (
		<article
			class="portrait-card utility-card connection-card"
			classList={{ 'is-entry': hasConnectionEntryLayout() }}
		>
			<div class="connection-top">
				<header class="utility-header">
					<Switch fallback={<strong>reply code</strong>}>
						<Match when={hasFindingRelayControl()}>
							<div class="connection-finding-header">
								<strong>reply code</strong>
								<p>Found the host. Keep this tab open to join the room.</p>
								<FindingRelayControl
									secondsLeft={findingRelaySecondsLeft() ?? 0}
									onTryRelay={props.onTryRelay}
								/>
							</div>
						</Match>
						<Match when={props.connection.side === 'host'}>
							<div class="connection-mode-heading">
								<strong>invite:</strong>
								<button
									type="button"
									aria-pressed={hostInviteMode() === 'link' ? 'true' : 'false'}
									onClick={() => setHostInviteMode('link')}
								>
									with link
								</button>
								<span>|</span>
								<button
									type="button"
									aria-pressed={hostInviteMode() === 'code' ? 'true' : 'false'}
									onClick={() => setHostInviteMode('code')}
								>
									with code
								</button>
							</div>
						</Match>
						<Match when={props.connection.side === 'closed'}>
							<strong>room closed</strong>
						</Match>
						<Match
							when={
								props.connection.side === 'guest' &&
								props.connection.status === 'connected'
							}
						>
							<strong>connected</strong>
						</Match>
					</Switch>
				</header>
				<Show when={hasConnectionCopy()}>
					<div class="connection-copy">
						<Switch
							fallback={
								<p>
									Send this reply code back to the person who invited you. They
									will paste it to let you in.
								</p>
							}
						>
							<Match when={props.connection.side === 'closed'}>
								<p>
									This room is no longer live. Start a new room or join someone
									else.
								</p>
							</Match>
							<Match
								when={
									props.connection.side === 'guest' &&
									props.connection.status === 'connected'
								}
							>
								<p>Connected directly.</p>
							</Match>
							<Match
								when={
									props.connection.side === 'guest' &&
									props.connection.status === 'needs-invite'
								}
							>
								<p>
									Paste an invite link or invite code from another device. Links
									can connect automatically; codes create a reply to send back.
								</p>
							</Match>
							<Match
								when={
									props.connection.side === 'guest' &&
									props.connection.status === 'creating-reply'
								}
							>
								<p>Creating a reply code. Keep this tab open.</p>
							</Match>
							<Match
								when={
									props.connection.side === 'guest' &&
									props.connection.status === 'reply-ready'
								}
							>
								<p>
									Send this reply code to the host. Keep this tab open until you
									appear in the room.
								</p>
							</Match>
							<Match
								when={
									props.connection.side === 'guest' &&
									props.connection.status === 'finding-link' &&
									hasClaimableFindingLink()
								}
							>
								<p>
									No host is here yet. Wait for them to open the link, or host
									this link yourself.
								</p>
							</Match>
							<Match
								when={
									props.connection.side === 'guest' &&
									props.connection.status === 'finding-link' &&
									hasReachableFindingLinkHost()
								}
							>
								<p>Found the host. Keep this tab open to join the room.</p>
							</Match>
							<Match
								when={
									props.connection.side === 'guest' &&
									props.connection.status === 'finding-link'
								}
							>
								<p>
									Finding the host from this invite link. If the wait feels too
									long, ask for an invite code.
								</p>
							</Match>
						</Switch>
						<Show
							when={
								props.connection.side !== 'closed' && props.connection.issue
							}
						>
							{(issue) => <p class="connection-issue">{issue()}</p>}
						</Show>
					</div>
				</Show>
			</div>
			<Switch>
				<Match when={props.connection.side === 'closed'}>
					<ConnectionActionRail>
						<button type="button" onClick={props.onBecomeHost}>
							start a new room
						</button>
						<Show when={props.canJoinExistingRoom}>
							<button type="button" onClick={props.onBecomeGuest}>
								join someone else
							</button>
						</Show>
					</ConnectionActionRail>
				</Match>
				<Match when={hostConnection()}>
					{(connection) => (
						<HostInvitePane
							connection={connection()}
							canJoinExistingRoom={props.canJoinExistingRoom}
							mode={hostInviteMode()}
							onAcceptReply={props.onAcceptReply}
							onBecomeGuest={props.onBecomeGuest}
							onCopyInviteLink={props.onCopyInviteLink}
							onCopyInviteCode={props.onCopyInviteCode}
							onSetReplyText={props.onSetReplyText}
						/>
					)}
				</Match>
				<Match when={guestConnection()}>
					{(connection) => (
						<GuestInvitePane
							canClaimFindingInviteLink={props.canClaimFindingInviteLink}
							connection={connection()}
							onBecomeHost={props.onBecomeHost}
							onClaimInviteLinkAsHost={props.onClaimInviteLinkAsHost}
							onCopyReplyCode={props.onCopyReplyCode}
							onCreateReply={props.onCreateReply}
							onSetInviteText={props.onSetInviteText}
							onTryRelay={props.onTryRelay}
						/>
					)}
				</Match>
			</Switch>
		</article>
	)
}
