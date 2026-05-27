import { createSignal, Match, onCleanup, Show, Switch } from 'solid-js'
import { canShareText, shareText } from './room/invite'
import { statusCopy } from './room/status-copy'
import type {
	ConnectionState,
	GuestConnectionState,
	HostConnectionState,
} from './state'

export type HostInviteMode = 'code' | 'link'

const ShareTextBlock = (props: {
	label: string
	value: string
	placeholder: string
	copyLabel: string
	shareLabel?: string
	disabled?: boolean
	onCopy?: () => void
}) => {
	let copiedTimeout: ReturnType<typeof setTimeout> | null = null
	const [copied, setCopied] = createSignal(false)
	const empty = () => props.value.trim() === ''
	const canShare = () => !empty() && canShareText(props.value)
	const actionLabel = () => {
		if (copied()) return 'copied'
		if (canShare()) return props.shareLabel ?? 'share'
		return props.copyLabel
	}

	const press = () => {
		if (canShare()) {
			void shareText(props.value)
			return
		}

		props.onCopy?.()
		setCopied(true)
		if (copiedTimeout != null) clearTimeout(copiedTimeout)
		copiedTimeout = setTimeout(() => setCopied(false), 1400)
	}

	onCleanup(() => {
		if (copiedTimeout != null) clearTimeout(copiedTimeout)
	})

	return (
		<div class="connection-copy-block" data-empty={empty() ? 'true' : 'false'}>
			<div class="connection-copy-head">
				<span>{props.label}</span>
				<button
					type="button"
					onClick={press}
					disabled={empty() || (props.disabled ?? false)}
					data-copied={copied() ? 'true' : 'false'}
				>
					{actionLabel()}
				</button>
			</div>
			{/* Codes are text memos. Show the whole thing; do not make users decode our UI. */}
			<pre>{empty() ? props.placeholder : props.value}</pre>
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
		<div class="connection-mode-frame" data-mode={props.mode}>
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
								Send this invite link to another device. Flop will try to find
								the other browser automatically.
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
							Use this invite code if the link does not connect. Send it, then
							paste their reply code here to let them in.
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
						<div class="connection-side-switch">
							<button type="button" onClick={props.onBecomeGuest}>
								join someone else instead
							</button>
						</div>
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
}) => {
	const creating = () => props.connection.status === 'creating-reply'
	const canShowCreate = () => props.connection.status !== 'finding-link'
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
					<div class="connection-main">
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
					<Show when={canShowCreate()}>
						<div class="card-actions">
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
						<div class="card-actions">
							<button type="button" onClick={props.onClaimInviteLinkAsHost}>
								host this link
							</button>
						</div>
					</Show>
				</Match>
				<Match when={props.connection.status === 'reply-ready'}>
					<div class="connection-main">
						<ShareTextBlock
							label="reply code"
							value={props.connection.replyCode}
							placeholder="reply code appears here"
							copyLabel="copy reply code"
							shareLabel="share reply code"
							onCopy={props.onCopyReplyCode}
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
				<div class="connection-side-switch">
					<button type="button" onClick={props.onBecomeHost}>
						start a room instead
					</button>
				</div>
			</Show>
		</>
	)
}

export const ConnectionCard = (props: {
	connection: ConnectionState
	canClaimFindingInviteLink: boolean
	canJoinExistingRoom: boolean
	initialHostInviteMode?: HostInviteMode
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
}) => {
	const hostConnection = () =>
		props.connection.side === 'host' ? props.connection : null
	const guestConnection = () =>
		props.connection.side === 'guest' ? props.connection : null
	const findingLinkHosts = () => {
		const connection = guestConnection()
		return connection?.status === 'finding-link'
			? (connection.inviteLinkPresence?.hosts ?? null)
			: null
	}
	const hasFindingLinkHost = () => (findingLinkHosts() ?? 0) > 0
	const hasClaimableFindingLink = () => {
		const connection = guestConnection()
		return (
			connection?.status === 'finding-link' &&
			connection.issue == null &&
			connection.inviteLinkPresence?.hosts === 0
		)
	}
	const hasReachableFindingLinkHost = () => {
		const connection = guestConnection()
		return connection?.issue == null && hasFindingLinkHost()
	}
	const [hostInviteMode, setHostInviteMode] = createSignal<HostInviteMode>(
		props.initialHostInviteMode ?? 'link',
	)

	return (
		<article
			class="portrait-card utility-card connection-card"
			data-side={props.connection.side}
		>
			<header class="utility-header">
				<Switch fallback={<strong>reply code</strong>}>
					<Match when={props.connection.side === 'host'}>
						<div class="connection-mode-heading">
							<strong>invite:</strong>
							<button
								type="button"
								data-active={hostInviteMode() === 'link' ? 'true' : 'false'}
								onClick={() => setHostInviteMode('link')}
							>
								with link
							</button>
							<span>|</span>
							<button
								type="button"
								data-active={hostInviteMode() === 'code' ? 'true' : 'false'}
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
			<Show when={props.connection.side !== 'host'}>
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
								Paste an invite link or invite code from another device. Then
								send back a reply code.
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
								Send this reply code to the host and keep this tab open.
								Refreshing loses this reply.
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
								No host is here yet. Wait if they are opening the link, or host
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
							<p>Found the host. Opening a direct browser connection.</p>
						</Match>
						<Match
							when={
								props.connection.side === 'guest' &&
								props.connection.status === 'finding-link'
							}
						>
							<p>
								Finding the host from this invite link. If the invite-link
								service cannot be reached, ask for an invite code.
							</p>
						</Match>
					</Switch>
					<Show
						when={props.connection.side !== 'closed' && props.connection.issue}
					>
						{(issue) => <p class="connection-issue">{issue()}</p>}
					</Show>
				</div>
			</Show>
			<Switch>
				<Match when={props.connection.side === 'closed'}>
					<div class="card-actions">
						<button type="button" onClick={props.onBecomeHost}>
							start a new room
						</button>
						<Show when={props.canJoinExistingRoom}>
							<button type="button" onClick={props.onBecomeGuest}>
								join someone else
							</button>
						</Show>
					</div>
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
						/>
					)}
				</Match>
			</Switch>
		</article>
	)
}
