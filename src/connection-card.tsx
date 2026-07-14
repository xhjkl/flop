import {
	createMemo,
	createSignal,
	type JSX,
	Match,
	Show,
	Switch,
} from 'solid-js'
import { Daisy } from './daisy'
import {
	type GuestJoinState,
	guestFindingLinkEntry,
	type HostInviteState,
	type RoomEntryState,
} from './room/entry/state'
import { canShareText, shareText } from './room/invite'
import { RELAY_FALLBACK_WAIT_SECONDS } from './room/relay'
import { entryIssueCopy, hostInviteLinkFailureCopy } from './ui/copy'
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
	entry: HostInviteState
	canJoinExistingRoom: boolean
	mode: HostInviteMode
	onAcceptReply: (replyText?: string) => void
	onBecomeGuest: () => void
	onCopyInviteLink: () => void
	onCopyInviteCode: () => void
	onSetReplyText: (replyText: string) => void
}) => {
	const busy = () =>
		props.entry.status === 'creating-invite' ||
		props.entry.status === 'accepting-reply'
	const inviteLinkReady = () => props.entry.inviteLinkStatus === 'ready'

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
						<Show when={props.entry.inviteLinkStatus === 'failed'}>
							<p class="connection-issue">{hostInviteLinkFailureCopy}</p>
						</Show>
					</div>
					<div class="connection-main">
						<ShareTextBlock
							label="invite link"
							value={inviteLinkReady() ? props.entry.inviteLink : ''}
							placeholder={
								props.entry.inviteLinkStatus === 'failed'
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
						<Show when={props.entry.issue}>
							{(issue) => (
								<p class="connection-issue">{entryIssueCopy[issue()]}</p>
							)}
						</Show>
					</div>
					<div class="connection-main">
						<ShareTextBlock
							label="invite code"
							value={props.entry.inviteCode}
							placeholder="invite code is being created"
							copyLabel="copy invite code"
							shareLabel="share invite code"
							disabled={props.mode !== 'code'}
							onCopy={props.onCopyInviteCode}
							qr
						/>
						<PasteLine
							label="paste their reply code here to let them in"
							value={props.entry.replyText}
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
	entry: GuestJoinState
	onBecomeHost: () => void
	onClaimInviteLinkAsHost: () => void
	onCopyReplyCode: () => void
	onCreateReply: (inviteText?: string) => void
	onSetInviteText: (inviteText: string) => void
	onTryRelay: () => void
}) => {
	const creating = () => props.entry.status === 'creating-reply'
	const hasInviteField = () => props.entry.status !== 'finding-link'
	const canCreate = () => creating() || props.entry.inviteText.trim() !== ''
	const canClaimFindingLink = () =>
		props.canClaimFindingInviteLink &&
		props.entry.status === 'finding-link' &&
		props.entry.issue == null &&
		props.entry.inviteLinkPresence?.hosts === 0

	return (
		<>
			{/* Guest flow: consume one invite, produce one reply code, then wait for the host to admit it. */}
			<Switch>
				<Match
					when={
						props.entry.status === 'needs-invite' ||
						props.entry.status === 'creating-reply' ||
						props.entry.status === 'finding-link'
					}
				>
					<div
						class="connection-main connection-body"
						classList={{
							'is-field': hasInviteField(),
						}}
					>
						<Show
							when={props.entry.status !== 'finding-link'}
							fallback={
								<ShareTextBlock
									label="invite link"
									value={props.entry.inviteText}
									placeholder="finding host"
									copyLabel="waiting"
									disabled
								/>
							}
						>
							<PasteLine
								label="paste invite link or invite code to create a reply code"
								value={props.entry.inviteText}
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
				<Match when={props.entry.status === 'reply-ready'}>
					<div class="connection-main connection-body">
						<ShareTextBlock
							label="reply code"
							value={props.entry.replyCode}
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
					props.entry.status !== 'connected' &&
					props.entry.status !== 'finding-link'
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
	entry: RoomEntryState
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
	const hostInvite = () => (props.entry.side === 'host' ? props.entry : null)
	const guestJoin = () => (props.entry.side === 'guest' ? props.entry : null)
	const findingLinkEntry = () => {
		const entry = guestJoin()
		return entry == null ? null : guestFindingLinkEntry(entry)
	}
	const findingLinkHosts = () => {
		return findingLinkEntry()?.inviteLinkPresence?.hosts ?? null
	}
	const hasFindingLinkHost = () => (findingLinkHosts() ?? 0) > 0
	const hasClaimableFindingLink = () => {
		const entry = findingLinkEntry()
		return (
			props.canClaimFindingInviteLink &&
			entry != null &&
			entry.issue == null &&
			entry.inviteLinkPresence?.hosts === 0
		)
	}
	const hasReachableFindingLinkHost = () => {
		const entry = guestJoin()
		return entry?.issue == null && hasFindingLinkHost()
	}
	const findingRelaySecondsLeft = () => {
		const entry = findingLinkEntry()
		if (entry == null) return null
		if (!hasReachableFindingLinkHost()) return null

		return entry.relayFallbackSecondsLeft
	}
	const hasFindingRelayControl = () => findingRelaySecondsLeft() != null
	const hasConnectionCopy = () =>
		props.entry.side !== 'host' && !hasFindingRelayControl()
	const hasConnectionEntryLayout = () => {
		const entry = guestJoin()
		return (
			entry?.status === 'needs-invite' || entry?.status === 'creating-reply'
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
						<Match when={props.entry.side === 'host'}>
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
						<Match when={props.entry.side === 'closed'}>
							<strong>room closed</strong>
						</Match>
						<Match
							when={
								props.entry.side === 'guest' &&
								props.entry.status === 'connected'
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
							<Match when={props.entry.side === 'closed'}>
								<p>
									This room is no longer live. Start a new room or join someone
									else.
								</p>
							</Match>
							<Match
								when={
									props.entry.side === 'guest' &&
									props.entry.status === 'connected'
								}
							>
								<p>Connected directly.</p>
							</Match>
							<Match
								when={
									props.entry.side === 'guest' &&
									props.entry.status === 'needs-invite'
								}
							>
								<p>
									Paste an invite link or invite code from another device. Links
									can connect automatically; codes create a reply to send back.
								</p>
							</Match>
							<Match
								when={
									props.entry.side === 'guest' &&
									props.entry.status === 'creating-reply'
								}
							>
								<p>Creating a reply code. Keep this tab open.</p>
							</Match>
							<Match
								when={
									props.entry.side === 'guest' &&
									props.entry.status === 'reply-ready'
								}
							>
								<p>
									Send this reply code to the host. Keep this tab open until you
									appear in the room.
								</p>
							</Match>
							<Match
								when={
									props.entry.side === 'guest' &&
									props.entry.status === 'finding-link' &&
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
									props.entry.side === 'guest' &&
									props.entry.status === 'finding-link' &&
									hasReachableFindingLinkHost()
								}
							>
								<p>Found the host. Keep this tab open to join the room.</p>
							</Match>
							<Match
								when={
									props.entry.side === 'guest' &&
									props.entry.status === 'finding-link'
								}
							>
								<p>
									Finding the host from this invite link. If the wait feels too
									long, ask for an invite code.
								</p>
							</Match>
						</Switch>
						<Show when={props.entry.side !== 'closed' && props.entry.issue}>
							{(issue) => (
								<p class="connection-issue">{entryIssueCopy[issue()]}</p>
							)}
						</Show>
					</div>
				</Show>
			</div>
			<Switch>
				<Match when={props.entry.side === 'closed'}>
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
				<Match when={hostInvite()}>
					{(entry) => (
						<HostInvitePane
							entry={entry()}
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
				<Match when={guestJoin()}>
					{(entry) => (
						<GuestInvitePane
							canClaimFindingInviteLink={props.canClaimFindingInviteLink}
							entry={entry()}
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
