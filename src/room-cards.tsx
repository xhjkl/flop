import { createSignal, Match, Show, Switch } from 'solid-js'
import type {
	BlipComposerState,
	ConnectionState,
	PortraitActivityState,
} from './room-types'
import { isGuestConnection, isHostConnection } from './room-types'
import { CardActions, SelfMediaCard } from './room-ui'
import type { SelfMedia, SelfMediaStatus } from './self-media'

type SelfMediaFailureState = Extract<
	SelfMediaStatus,
	'denied' | 'missing' | 'unsupported' | 'error'
>

const selfMediaFailureTitles = {
	denied: 'Access denied',
	missing: 'No devices found',
	unsupported: 'Browser unsupported',
	error: 'Could not start media',
} satisfies Record<SelfMediaFailureState, string>

function mediaFailureIssue(selfMedia: SelfMedia) {
	return (
		selfMedia.issue ?? 'The browser could not open the camera and microphone.'
	)
}

function mediaFailureTitle(status: SelfMediaStatus) {
	return status in selfMediaFailureTitles
		? selfMediaFailureTitles[status as SelfMediaFailureState]
		: 'Could not start media'
}

function MediaFailureCard(props: {
	title: string
	media: SelfMedia
	onEnableSelfMedia: () => void
}) {
	return (
		<SelfMediaCard
			media={props.media}
			title={props.title}
			actions={[{ label: 'try again', onPress: props.onEnableSelfMedia }]}
		>
			<p>{mediaFailureIssue(props.media)}</p>
			<p>Fix it and try again here.</p>
		</SelfMediaCard>
	)
}

export function SelfPortraitCard(props: {
	activity: PortraitActivityState
	canBlip: boolean
	blipComposer: BlipComposerState
	media: SelfMedia
	onSendBlip: () => void
	onEnableSelfMedia: () => void
	onSetBlipText: (text: string) => void
	onToggleCamera: () => void
	onToggleMicrophone: () => void
}) {
	return (
		// Welcome and permission are one portrait so the first step never feels like a modal.
		<Switch
			fallback={
				<MediaFailureCard
					title={mediaFailureTitle(props.media.status)}
					media={props.media}
					onEnableSelfMedia={props.onEnableSelfMedia}
				/>
			}
		>
			<Match when={props.media.status === 'ready'}>
				<SelfMediaCard
					activity={props.activity}
					canBlip={props.canBlip}
					blipComposer={props.blipComposer}
					media={props.media}
					title="welcome to flop"
					actions={[
						{
							label: 'enable camera + mic',
							onPress: props.onEnableSelfMedia,
						},
					]}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
				>
					<p>
						Share the invite code, paste back the reply code, and send files
						device-to-device. Use the button below to turn on camera and
						microphone so other peers can see you.
					</p>
					{/* Future preflight? You'll get a quick mirror check before you go live. */}
				</SelfMediaCard>
			</Match>
			<Match when={props.media.status === 'requesting'}>
				<SelfMediaCard
					activity={props.activity}
					canBlip={props.canBlip}
					blipComposer={props.blipComposer}
					media={props.media}
					title="Allow camera + mic"
					actions={[{ label: 'waiting for permission', disabled: true }]}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
				>
					<p>
						The browser should be asking for permission now so this card can
						turn into your live portrait.
					</p>
				</SelfMediaCard>
			</Match>
			<Match when={props.media.status === 'live'}>
				<SelfMediaCard
					activity={props.activity}
					canBlip={props.canBlip}
					blipComposer={props.blipComposer}
					media={props.media}
					cameraToggle={{
						onPress: props.onToggleCamera,
						disabled: !props.media.cameraAvailable,
					}}
					microphoneToggle={{
						onPress: props.onToggleMicrophone,
						disabled: !props.media.microphoneAvailable,
					}}
					onSendBlip={props.onSendBlip}
					onSetBlipText={props.onSetBlipText}
				/>
			</Match>
		</Switch>
	)
}

function connectionTitle(connection: ConnectionState) {
	if (connection.phase === 'closed') return 'room closed'
	if (connection.phase === 'connected') return 'connected'
	return isHostConnection(connection.phase) ? 'invite' : 'reply'
}

function connectionBody(connection: ConnectionState) {
	if (connection.phase === 'closed') {
		return 'This direct connection is closed. Host a fresh room or join an existing one.'
	}

	if (connection.phase === 'connected') {
		return 'The browsers are connected directly.'
	}

	if (isHostConnection(connection.phase)) {
		return 'Send this invite to the other device. They open it, then send one reply back.'
	}

	if (connection.phase === 'needs-invite') {
		return 'Paste the invite from the other device. Then send one reply back.'
	}

	return 'Send this reply back to the inviter. Once they paste it, the browsers connect directly.'
}

function ConnectionIssue(props: { connection: ConnectionState }) {
	return (
		<Show when={props.connection.phase !== 'closed' && props.connection.issue}>
			{(issue) => <p class="connection-issue">{issue()}</p>}
		</Show>
	)
}

function CopyBlock(props: {
	label: string
	value: string
	placeholder: string
	copyLabel: string
	onCopy: () => void
}) {
	let copiedTimeout: ReturnType<typeof setTimeout> | null = null
	const [copied, setCopied] = createSignal(false)
	const empty = () => props.value.trim() === ''

	function copy() {
		props.onCopy()
		setCopied(true)
		if (copiedTimeout != null) clearTimeout(copiedTimeout)
		copiedTimeout = setTimeout(() => setCopied(false), 1400)
	}

	return (
		<div class="connection-copy-block">
			<div class="connection-copy-head">
				<span>{props.label}</span>
				<button
					type="button"
					onClick={copy}
					disabled={empty()}
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

function CodeInput(props: {
	label: string
	value: string
	placeholder: string
	disabled?: boolean
	onChange: (text: string) => void
	onSubmit: (text?: string) => void
}) {
	function submit(text?: string) {
		if ((text ?? props.value).trim() === '') return
		props.onSubmit(text)
	}

	function submitPaste(event: ClipboardEvent) {
		const text = event.clipboardData?.getData('text') ?? ''
		if (text.trim() === '') return

		// Paste is the happy path. Enter is just there for people who type anyway.
		event.preventDefault()
		submit(text)
	}

	function submitEnter(event: KeyboardEvent) {
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

function SideSwitch(props: { label: string; onPress: () => void }) {
	return (
		<div class="connection-side-switch">
			<button type="button" onClick={props.onPress}>
				{props.label}
			</button>
		</div>
	)
}

function HostConnectionFields(props: {
	connection: ConnectionState
	hasPeers: boolean
	onAcceptReply: (replyText?: string) => void
	onBecomeGuest: () => void
	onCopyInviteLink: () => void
	onSetReplyText: (replyText: string) => void
}) {
	const busy = () =>
		props.connection.phase === 'creating-invite' ||
		props.connection.phase === 'accepting-reply'

	return (
		<>
			{/* Host flow: send one invite out, paste one reply back, admit one guest. */}
			<div class="connection-main">
				<CopyBlock
					label="invite"
					value={props.connection.inviteLink}
					placeholder="invite is being created"
					copyLabel="copy invite"
					onCopy={props.onCopyInviteLink}
				/>
				<CodeInput
					label="paste their reply here to let them in"
					value={props.connection.replyText}
					placeholder="paste reply"
					disabled={busy()}
					onChange={props.onSetReplyText}
					onSubmit={props.onAcceptReply}
				/>
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

function GuestConnectionFields(props: {
	connection: ConnectionState
	onBecomeHost: () => void
	onCopyReplyCode: () => void
	onCreateReply: (inviteText?: string) => void
	onSetInviteText: (inviteText: string) => void
}) {
	const creating = () => props.connection.phase === 'creating-reply'
	const canCreate = () =>
		creating() || props.connection.inviteText.trim() !== ''

	return (
		<>
			{/* Guest flow: consume one invite, produce one reply, then wait for the host to admit it. */}
			<Switch>
				<Match
					when={
						props.connection.phase === 'needs-invite' ||
						props.connection.phase === 'creating-reply'
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
				<Match when={props.connection.phase === 'reply-ready'}>
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
			<Show when={props.connection.phase !== 'connected'}>
				<SideSwitch label="host a room instead" onPress={props.onBecomeHost} />
			</Show>
		</>
	)
}

function ClosedConnectionFields(props: {
	onBecomeGuest: () => void
	onBecomeHost: () => void
}) {
	return (
		<CardActions
			actions={[
				{ label: 'host a fresh room', onPress: props.onBecomeHost },
				{ label: 'join existing room', onPress: props.onBecomeGuest },
			]}
		/>
	)
}

export function ConnectionCard(props: {
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
}) {
	return (
		<article class="portrait-card utility-card connection-card">
			<header class="utility-header">
				<strong>{connectionTitle(props.connection)}</strong>
			</header>
			<div class="connection-copy">
				<p>{connectionBody(props.connection)}</p>
				<ConnectionIssue connection={props.connection} />
			</div>
			<Switch>
				<Match when={props.connection.phase === 'closed'}>
					<ClosedConnectionFields
						onBecomeGuest={props.onBecomeGuest}
						onBecomeHost={props.onBecomeHost}
					/>
				</Match>
				<Match when={isHostConnection(props.connection.phase)}>
					<HostConnectionFields
						connection={props.connection}
						hasPeers={props.hasPeers ?? false}
						onAcceptReply={props.onAcceptReply}
						onBecomeGuest={props.onBecomeGuest}
						onCopyInviteLink={props.onCopyInviteLink}
						onSetReplyText={props.onSetReplyText}
					/>
				</Match>
				<Match when={isGuestConnection(props.connection.phase)}>
					<GuestConnectionFields
						connection={props.connection}
						onBecomeHost={props.onBecomeHost}
						onCopyReplyCode={props.onCopyReplyCode}
						onCreateReply={props.onCreateReply}
						onSetInviteText={props.onSetInviteText}
					/>
				</Match>
			</Switch>
		</article>
	)
}
