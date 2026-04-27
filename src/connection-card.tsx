import { createSignal, Match, onCleanup, Show, Switch } from 'solid-js'
import { CardActions } from './portraits'
import { canShareText, shareText } from './room/invite'
import type {
	ConnectionState,
	GuestConnectionState,
	HostConnectionState,
} from './state'

export type HostInviteMode = 'code' | 'link'

const connectionTitle = (connection: ConnectionState) => {
	if (connection.side === 'closed') return 'room closed'
	if (connection.side === 'guest' && connection.status === 'connected') {
		return 'connected'
	}
	return connection.side === 'host' ? 'invite' : 'reply code'
}

const connectionBody = (connection: ConnectionState) => {
	if (connection.side === 'closed') {
		return 'This room has ended. Start a new room or join someone else.'
	}

	if (connection.side === 'guest' && connection.status === 'connected') {
		return 'The browsers are connected directly.'
	}

	if (connection.side === 'host') {
		return ''
	}

	if (connection.status === 'needs-invite') {
		return 'Paste the invite link or invite code from the other device. Then send a reply code back.'
	}

	if (connection.status === 'finding-link') {
		return 'Finding the host from the invite link. If this keeps waiting, ask for the invite code instead.'
	}

	return 'Send this reply code back to the person who invited you. They will paste it to let you in.'
}

const ConnectionIssue = (props: { connection: ConnectionState }) => {
	return (
		<Show when={props.connection.side !== 'closed' && props.connection.issue}>
			{(issue) => <p class="connection-issue">{issue()}</p>}
		</Show>
	)
}

const CopyBlock = (props: {
	label: string
	value: string
	placeholder: string
	copyLabel: string
	shareLabel?: string
	disabled?: boolean
	onCopy: () => void
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

		props.onCopy()
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

const CodeInput = (props: {
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

const SideSwitch = (props: { label: string; onPress: () => void }) => {
	return (
		<div class="connection-side-switch">
			<button type="button" onClick={props.onPress}>
				{props.label}
			</button>
		</div>
	)
}

const HostInviteTabs = (props: {
	mode: HostInviteMode
	onMode: (mode: HostInviteMode) => void
}) => {
	return (
		<div class="connection-mode-heading">
			<strong>invite:</strong>
			<button
				type="button"
				data-active={props.mode === 'link' ? 'true' : 'false'}
				onClick={() => props.onMode('link')}
			>
				with link
			</button>
			<span>|</span>
			<button
				type="button"
				data-active={props.mode === 'code' ? 'true' : 'false'}
				onClick={() => props.onMode('code')}
			>
				with code
			</button>
		</div>
	)
}

const HostConnectionFields = (props: {
	connection: HostConnectionState
	canJoinExistingRoom: boolean
	mode: HostInviteMode
	onAcceptReply: (replyText?: string) => void
	onBecomeGuest: () => void
	onCopyAutoInviteLink: () => void
	onCopyManualInviteLink: () => void
	onSetReplyText: (replyText: string) => void
}) => {
	const busy = () =>
		props.connection.status === 'creating-invite' ||
		props.connection.status === 'accepting-reply'
	const autoLinkReady = () => props.connection.autoStatus === 'ready'
	const autoLinkUnavailable = () => props.connection.autoStatus === 'failed'
	const autoLinkCopyValue = () =>
		autoLinkReady() ? props.connection.autoInviteLink : ''
	const autoLinkPlaceholder = () =>
		autoLinkUnavailable()
			? 'invite link is unavailable'
			: 'preparing invite link'

	return (
		<div class="connection-mode-frame" data-mode={props.mode}>
			<div class="connection-mode-rail">
				<div
					class="connection-mode-pane"
					aria-hidden={props.mode === 'link' ? 'false' : 'true'}
				>
					<div class="connection-copy">
						<Show
							when={autoLinkReady()}
							fallback={
								<p>
									Preparing the invite link. Wait for it to be ready, then send
									the invite link to the other device.
								</p>
							}
						>
							<p>
								Send the invite link to the other device. Flop will try to find
								it automatically.
							</p>
						</Show>
						<Show when={props.connection.autoStatus === 'failed'}>
							<p class="connection-issue">
								The invite link could not finish connecting. Use the invite code
								instead.
							</p>
						</Show>
					</div>
					<div class="connection-main">
						<CopyBlock
							label="invite link"
							value={autoLinkCopyValue()}
							placeholder={autoLinkPlaceholder()}
							copyLabel={autoLinkReady() ? 'copy link' : 'preparing'}
							shareLabel="share link"
							disabled={!autoLinkReady()}
							onCopy={props.onCopyAutoInviteLink}
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
							Use the invite code if the invite link does not connect. Send the
							invite code, then paste their reply code.
						</p>
						<ConnectionIssue connection={props.connection} />
					</div>
					<div class="connection-main">
						<CopyBlock
							label="invite code"
							value={props.connection.manualInviteLink}
							placeholder="invite code is being created"
							copyLabel="copy invite code"
							shareLabel="share invite code"
							disabled={props.mode !== 'code'}
							onCopy={props.onCopyManualInviteLink}
						/>
						<CodeInput
							label="paste their reply code here to let them in"
							value={props.connection.replyText}
							placeholder="paste reply code"
							disabled={busy() || props.mode !== 'code'}
							onChange={props.onSetReplyText}
							onSubmit={props.onAcceptReply}
						/>
					</div>
					<Show when={props.canJoinExistingRoom}>
						<SideSwitch
							label="join someone else instead"
							onPress={props.onBecomeGuest}
						/>
					</Show>
				</div>
			</div>
		</div>
	)
}

const GuestConnectionFields = (props: {
	connection: GuestConnectionState
	onBecomeHost: () => void
	onCopyReplyCode: () => void
	onCreateReply: (inviteText?: string) => void
	onSetInviteText: (inviteText: string) => void
}) => {
	const creating = () => props.connection.status === 'creating-reply'
	const canShowCreate = () => props.connection.status !== 'finding-link'
	const canCreate = () =>
		creating() || props.connection.inviteText.trim() !== ''

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
								<CopyBlock
									label="invite link"
									value={props.connection.inviteText}
									placeholder="finding host"
									copyLabel="waiting"
									disabled
									onCopy={() => null}
								/>
							}
						>
							<CodeInput
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
						<CardActions
							actions={[
								{
									label: creating()
										? 'creating reply code'
										: 'create reply code',
									onPress: props.onCreateReply,
									disabled: !canCreate(),
								},
							]}
						/>
					</Show>
				</Match>
				<Match when={props.connection.status === 'reply-ready'}>
					<div class="connection-main">
						<CopyBlock
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
				<SideSwitch label="start a room instead" onPress={props.onBecomeHost} />
			</Show>
		</>
	)
}

const ClosedConnectionFields = (props: {
	canJoinExistingRoom: boolean
	onBecomeGuest: () => void
	onBecomeHost: () => void
}) => {
	return (
		<CardActions
			actions={[
				{ label: 'start a new room', onPress: props.onBecomeHost },
				...(props.canJoinExistingRoom
					? [{ label: 'join someone else', onPress: props.onBecomeGuest }]
					: []),
			]}
		/>
	)
}

export const ConnectionCard = (props: {
	connection: ConnectionState
	canJoinExistingRoom: boolean
	initialHostInviteMode?: HostInviteMode
	onAcceptReply: (replyText?: string) => void
	onBecomeGuest: () => void
	onBecomeHost: () => void
	onCopyAutoInviteLink: () => void
	onCopyManualInviteLink: () => void
	onCopyReplyCode: () => void
	onCreateReply: (inviteText?: string) => void
	onSetInviteText: (inviteText: string) => void
	onSetReplyText: (replyText: string) => void
}) => {
	const hostConnection = () =>
		props.connection.side === 'host' ? props.connection : null
	const guestConnection = () =>
		props.connection.side === 'guest' ? props.connection : null
	const [hostInviteMode, setHostInviteMode] = createSignal<HostInviteMode>(
		props.initialHostInviteMode ?? 'link',
	)

	return (
		<article
			class="portrait-card utility-card connection-card"
			data-side={props.connection.side}
		>
			<header class="utility-header">
				<Show
					when={props.connection.side === 'host'}
					fallback={<strong>{connectionTitle(props.connection)}</strong>}
				>
					<HostInviteTabs mode={hostInviteMode()} onMode={setHostInviteMode} />
				</Show>
			</header>
			<Show when={props.connection.side !== 'host'}>
				<div class="connection-copy">
					<p>{connectionBody(props.connection)}</p>
					<ConnectionIssue connection={props.connection} />
				</div>
			</Show>
			<Switch>
				<Match when={props.connection.side === 'closed'}>
					<ClosedConnectionFields
						canJoinExistingRoom={props.canJoinExistingRoom}
						onBecomeGuest={props.onBecomeGuest}
						onBecomeHost={props.onBecomeHost}
					/>
				</Match>
				<Match when={hostConnection()}>
					{(connection) => (
						<HostConnectionFields
							connection={connection()}
							canJoinExistingRoom={props.canJoinExistingRoom}
							mode={hostInviteMode()}
							onAcceptReply={props.onAcceptReply}
							onBecomeGuest={props.onBecomeGuest}
							onCopyAutoInviteLink={props.onCopyAutoInviteLink}
							onCopyManualInviteLink={props.onCopyManualInviteLink}
							onSetReplyText={props.onSetReplyText}
						/>
					)}
				</Match>
				<Match when={guestConnection()}>
					{(connection) => (
						<GuestConnectionFields
							connection={connection()}
							onBecomeHost={props.onBecomeHost}
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
