import { createSignal, Match, onCleanup, Show, Switch } from 'solid-js'
import { CardActions } from './portraits'
import type {
	ConnectionState,
	GuestConnectionState,
	HostConnectionState,
} from './state'

type HostInviteMode = 'code' | 'link'

const connectionTitle = (connection: ConnectionState) => {
	if (connection.side === 'closed') return 'room closed'
	if (connection.side === 'guest' && connection.status === 'connected') {
		return 'connected'
	}
	return connection.side === 'host' ? 'invite' : 'reply'
}

const connectionBody = (connection: ConnectionState) => {
	if (connection.side === 'closed') {
		return 'This direct connection is closed. Host a fresh room or join an existing one.'
	}

	if (connection.side === 'guest' && connection.status === 'connected') {
		return 'The browsers are connected directly.'
	}

	if (connection.side === 'host') {
		return ''
	}

	if (connection.status === 'needs-invite') {
		return 'Paste the invite from the other device. Then send one reply back.'
	}

	return 'Send this reply back to the inviter. Once they paste it, the browsers connect directly.'
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
	disabled?: boolean
	onCopy: () => void
}) => {
	let copiedTimeout: ReturnType<typeof setTimeout> | null = null
	const [copied, setCopied] = createSignal(false)
	const empty = () => props.value.trim() === ''

	const copy = () => {
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
					onClick={copy}
					disabled={empty() || (props.disabled ?? false)}
					data-copied={copied() ? 'true' : 'false'}
				>
					{copied() ? 'copied' : props.copyLabel}
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
	hasPeers: boolean
	mode: HostInviteMode
	onAcceptReply: (replyText?: string) => void
	onBecomeGuest: () => void
	onCopyInviteLink: () => void
	onSetReplyText: (replyText: string) => void
}) => {
	const busy = () =>
		props.connection.status === 'creating-invite' ||
		props.connection.status === 'accepting-reply'

	return (
		<>
			<div class="connection-mode-frame" data-mode={props.mode}>
				<div class="connection-mode-rail">
					<div
						class="connection-mode-pane"
						aria-hidden={props.mode === 'link' ? 'false' : 'true'}
					>
						<div class="connection-copy">
							<p>
								Send this link to the other device. Flop will try to find it
								automatically.
							</p>
						</div>
						<div class="connection-main">
							<CopyBlock
								label="link"
								value=""
								placeholder="automatic invite link is coming next"
								copyLabel="copy link"
								disabled
								onCopy={() => null}
							/>
						</div>
					</div>
					<div
						class="connection-mode-pane"
						aria-hidden={props.mode === 'code' ? 'false' : 'true'}
					>
						{/* Manual host flow: send one invite out, paste one reply back, admit one guest. */}
						<div class="connection-copy">
							<p>
								Use this if the link does not connect. Send this invite code,
								then paste their reply.
							</p>
							<ConnectionIssue connection={props.connection} />
						</div>
						<div class="connection-main">
							<CopyBlock
								label="invite code"
								value={props.connection.inviteLink}
								placeholder="invite code is being created"
								copyLabel="copy code"
								disabled={props.mode !== 'code'}
								onCopy={props.onCopyInviteLink}
							/>
							<CodeInput
								label="paste their reply here to let them in"
								value={props.connection.replyText}
								placeholder="paste reply"
								disabled={busy() || props.mode !== 'code'}
								onChange={props.onSetReplyText}
								onSubmit={props.onAcceptReply}
							/>
						</div>
					</div>
				</div>
			</div>
			<Show when={!props.hasPeers}>
				<SideSwitch
					label="join existing room instead"
					onPress={props.onBecomeGuest}
				/>
			</Show>
		</>
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
	const canCreate = () =>
		creating() || props.connection.inviteText.trim() !== ''

	return (
		<>
			{/* Guest flow: consume one invite, produce one reply, then wait for the host to admit it. */}
			<Switch>
				<Match
					when={
						props.connection.status === 'needs-invite' ||
						props.connection.status === 'creating-reply'
					}
				>
					<div class="connection-main">
						<CodeInput
							label="paste invite to create a reply"
							value={props.connection.inviteText}
							placeholder="paste invite"
							disabled={creating()}
							onChange={props.onSetInviteText}
							onSubmit={props.onCreateReply}
						/>
					</div>
					<Show when={canCreate()}>
						<CardActions
							actions={[
								{
									label: creating() ? 'creating reply' : 'create reply',
									onPress: props.onCreateReply,
									disabled: creating(),
								},
							]}
						/>
					</Show>
				</Match>
				<Match when={props.connection.status === 'reply-ready'}>
					<div class="connection-main">
						<CopyBlock
							label="reply"
							value={props.connection.replyCode}
							placeholder="reply appears here"
							copyLabel="copy reply"
							onCopy={props.onCopyReplyCode}
						/>
					</div>
				</Match>
			</Switch>
			<Show when={props.connection.status !== 'connected'}>
				<SideSwitch label="host a room instead" onPress={props.onBecomeHost} />
			</Show>
		</>
	)
}

const ClosedConnectionFields = (props: {
	onBecomeGuest: () => void
	onBecomeHost: () => void
}) => {
	return (
		<CardActions
			actions={[
				{ label: 'host a fresh room', onPress: props.onBecomeHost },
				{ label: 'join existing room', onPress: props.onBecomeGuest },
			]}
		/>
	)
}

export const ConnectionCard = (props: {
	connection: ConnectionState
	hasPeers?: boolean
	onAcceptReply: (replyText?: string) => void
	onBecomeGuest: () => void
	onBecomeHost: () => void
	onCopyInviteLink: () => void
	onCopyReplyCode: () => void
	onCreateReply: (inviteText?: string) => void
	onSetInviteText: (inviteText: string) => void
	onSetReplyText: (replyText: string) => void
}) => {
	const hostConnection = () =>
		props.connection.side === 'host' ? props.connection : null
	const guestConnection = () =>
		props.connection.side === 'guest' ? props.connection : null
	const [hostInviteMode, setHostInviteMode] =
		createSignal<HostInviteMode>('link')

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
						onBecomeGuest={props.onBecomeGuest}
						onBecomeHost={props.onBecomeHost}
					/>
				</Match>
				<Match when={hostConnection()}>
					{(connection) => (
						<HostConnectionFields
							connection={connection()}
							hasPeers={props.hasPeers ?? false}
							mode={hostInviteMode()}
							onAcceptReply={props.onAcceptReply}
							onBecomeGuest={props.onBecomeGuest}
							onCopyInviteLink={props.onCopyInviteLink}
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
