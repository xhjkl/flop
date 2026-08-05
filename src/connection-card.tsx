import { createMemo, createSignal, Match, Show, Switch } from 'solid-js'
import { Daisy } from './daisy'
import {
	asHostDiscovery,
	type GuestJoinState,
	type HostInviteState,
	type RoomEntryState,
} from './room/entry/state'
import { RELAY_FALLBACK_WAIT_SECONDS } from './room/relay'
import { entryIssueCopy, hostInviteLinkFailureCopy } from './ui/copy'
import { createPulse } from './ui/pulse'
import { encodeQrCode } from './ui/qr-code'

type HostInviteMode = 'code' | 'link'

const shareData = (text: string): ShareData => {
	const value = text.trim()
	try {
		const url = new URL(value)
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			return { title: 'Flop invite', url: url.href }
		}
	} catch {}
	return { text: value, title: 'Flop invite' }
}

const canShare = (text: string) => {
	if (
		typeof navigator === 'undefined' ||
		typeof navigator.share !== 'function'
	) {
		return false
	}
	try {
		return navigator.canShare?.(shareData(text)) ?? true
	} catch {
		return false
	}
}

const ShareTextBlock = (props: {
	label: string
	value: string
	placeholder: string
	copyLabel: string
	shareLabel?: string
	disabled?: boolean
	qr?: boolean
}) => {
	const copied = createPulse(1400)
	const empty = () => props.value.trim() === ''
	const useShareSheet = () => !empty() && canShare(props.value)
	const qr = createMemo(() =>
		(props.qr ?? false) && !empty() ? encodeQrCode(props.value) : null,
	)
	const actionLabel = () => {
		if (props.disabled === true) return props.copyLabel
		if (copied.active()) return 'copied'
		if (useShareSheet()) return props.shareLabel ?? 'share'
		return props.copyLabel
	}

	const canCopy = () =>
		typeof navigator !== 'undefined' &&
		typeof navigator.clipboard?.writeText === 'function'
	const press = async () => {
		try {
			if (useShareSheet()) {
				await navigator.share(shareData(props.value))
				return
			}
			if (!canCopy()) return

			await navigator.clipboard.writeText(props.value)
			copied.trigger()
		} catch {}
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
					onClick={() => void press()}
					disabled={
						empty() ||
						(props.disabled ?? false) ||
						(!useShareSheet() && !canCopy())
					}
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
					{(code) => (
						<svg
							class="connection-copy-qr"
							viewBox={`0 0 ${code().size} ${code().size}`}
							aria-hidden="true"
						>
							<rect
								class="connection-copy-qr-paper"
								width={code().size}
								height={code().size}
							/>
							<path class="connection-copy-qr-ink" d={code().path} />
						</svg>
					)}
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
	onSubmit: (text: string) => void
}) => {
	const submit = (text = props.value) => {
		if (text.trim() === '') return
		props.onSubmit(text)
	}

	const submitPaste = (event: ClipboardEvent) => {
		const text = event.clipboardData?.getData('text') ?? ''
		if (text.trim() === '') return

		// Submit clipboard text directly; the controlled input has not observed it yet.
		event.preventDefault()
		submit(text)
	}

	const submitEnter = (event: KeyboardEvent) => {
		if (event.key !== 'Enter' || event.isComposing) return
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
	canBecomeGuest: boolean
	mode: HostInviteMode
	onAcceptReplyCode: (replyText: string) => void
	onBecomeGuest: () => void
	onSetReplyText: (replyText: string) => void
}) => {
	const busy = () =>
		props.entry.manualPhase === 'preparing-code' ||
		props.entry.manualPhase === 'accepting-reply'
	const inviteLinkReady = () => props.entry.inviteLinkPhase === 'ready'

	return (
		<div class="connection-mode-frame connection-body">
			<div class="connection-mode-rail">
				<Show
					when={props.mode === 'link'}
					fallback={
						<div class="connection-mode-pane">
							<div class="connection-copy">
								<p>
									Use this invite code if the link does not bring them in. Send
									it, then paste their reply code here.
								</p>
								<Show when={props.entry.issue}>
									{(issue) => (
										<p class="connection-issue" role="status">
											{entryIssueCopy[issue()]}
										</p>
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
									qr
								/>
								<PasteLine
									label="paste their reply code here to let them in"
									value={props.entry.replyText}
									placeholder="paste reply code"
									disabled={busy()}
									onChange={props.onSetReplyText}
									onSubmit={props.onAcceptReplyCode}
								/>
							</div>
							<Show when={props.canBecomeGuest}>
								<div class="card-actions connection-side-switch connection-action">
									<button type="button" onClick={props.onBecomeGuest}>
										join someone else instead
									</button>
								</div>
							</Show>
						</div>
					}
				>
					<div class="connection-mode-pane">
						<div class="connection-copy">
							<Show
								when={inviteLinkReady()}
								fallback={
									<p>
										Preparing an invite link. When it is ready, send it to
										another device.
									</p>
								}
							>
								<p>
									Send this invite link to another device. If it works, they
									will appear here automatically.
								</p>
							</Show>
							<Show when={props.entry.inviteLinkPhase === 'failed'}>
								<p class="connection-issue" role="status">
									{hostInviteLinkFailureCopy}
								</p>
							</Show>
						</div>
						<div class="connection-main">
							<ShareTextBlock
								label="invite link"
								value={inviteLinkReady() ? props.entry.inviteLink : ''}
								placeholder={
									props.entry.inviteLinkPhase === 'failed'
										? 'invite link is unavailable'
										: 'preparing invite link'
								}
								copyLabel={inviteLinkReady() ? 'copy link' : 'preparing'}
								shareLabel="share link"
								disabled={!inviteLinkReady()}
								qr={inviteLinkReady()}
							/>
						</div>
					</div>
				</Show>
			</div>
		</div>
	)
}

const GuestInvitePane = (props: {
	canClaimInviteAsHost: boolean
	entry: GuestJoinState
	onBecomeHost: () => void
	onClaimInviteLinkAsHost: () => void
	onJoinInvite: (inviteText: string) => void
	onSetInviteText: (inviteText: string) => void
}) => {
	const creating = () => props.entry.status === 'creating-reply'
	const hasInviteField = () => props.entry.status !== 'discovering-host'
	const canCreate = () => !creating() && props.entry.inviteText.trim() !== ''

	return (
		<>
			<Switch>
				<Match
					when={
						props.entry.status === 'needs-invite' ||
						props.entry.status === 'creating-reply' ||
						props.entry.status === 'discovering-host'
					}
				>
					<div
						class="connection-main connection-body"
						classList={{
							'is-field': hasInviteField(),
						}}
					>
						<Show
							when={props.entry.status !== 'discovering-host'}
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
								onSubmit={props.onJoinInvite}
							/>
						</Show>
					</div>
					<Show when={hasInviteField()}>
						<div class="card-actions connection-action">
							<button
								type="button"
								onClick={() => props.onJoinInvite(props.entry.inviteText)}
								disabled={!canCreate()}
							>
								{creating() ? 'creating reply code' : 'create reply code'}
							</button>
						</div>
					</Show>
					<Show when={props.canClaimInviteAsHost}>
						<div class="card-actions connection-action">
							<button type="button" onClick={props.onClaimInviteLinkAsHost}>
								host this link
							</button>
						</div>
					</Show>
				</Match>
				<Match when={props.entry.status === 'reply-ready' ? props.entry : null}>
					{(entry) => (
						<div class="connection-main connection-body">
							<ShareTextBlock
								label="reply code"
								value={entry().replyCode}
								placeholder="reply code appears here"
								copyLabel="copy reply code"
								shareLabel="share reply code"
								qr
							/>
						</div>
					)}
				</Match>
			</Switch>
			<Show
				when={
					props.entry.status !== 'connected' &&
					props.entry.status !== 'discovering-host'
				}
			>
				<div class="card-actions connection-side-switch connection-action">
					<button type="button" onClick={props.onBecomeHost}>
						start a room instead
					</button>
				</div>
			</Show>
		</>
	)
}

const RelayFallbackControl = (props: {
	secondsLeft: number
	onTryRelay: () => void
}) => {
	return (
		<Show
			when={props.secondsLeft <= 0}
			fallback={
				<Daisy
					ariaLabel={`${Math.ceil(props.secondsLeft)} seconds until relay is available`}
					max={RELAY_FALLBACK_WAIT_SECONDS}
					text={`${Math.ceil(props.secondsLeft)}`}
					value={props.secondsLeft}
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

const connectionHeading = (entry: RoomEntryState) => {
	if (entry.side === 'host') return 'invite'
	if (entry.side === 'closed') return 'room closed'

	switch (entry.status) {
		case 'needs-invite':
			return 'join a room'
		case 'creating-reply':
			return 'creating reply code'
		case 'discovering-host':
			return 'finding host'
		case 'reply-ready':
			return 'reply code'
		case 'connected':
			return 'connected'
	}
}

export const ConnectionCard = (props: {
	entry: RoomEntryState
	canClaimInviteAsHost: boolean
	canBecomeGuest: boolean
	onAcceptReplyCode: (replyText: string) => void
	onBecomeGuest: () => void
	onBecomeHost: () => void
	onClaimInviteLinkAsHost: () => void
	onJoinInvite: (inviteText: string) => void
	onSetInviteText: (inviteText: string) => void
	onSetReplyText: (replyText: string) => void
	onTryRelay: () => void
}) => {
	const hostInvite = () => (props.entry.side === 'host' ? props.entry : null)
	const guestJoin = () => (props.entry.side === 'guest' ? props.entry : null)
	const hostDiscovery = () => {
		const entry = guestJoin()
		return entry == null ? null : asHostDiscovery(entry)
	}
	const hostPresent = () => hostDiscovery()?.hostPresent === true
	const hostReachable = () => {
		const entry = guestJoin()
		return entry?.issue == null && hostPresent()
	}
	const relayFallbackSecondsLeft = () => {
		const entry = hostDiscovery()
		if (entry == null) return null
		if (!hostReachable()) return null

		return entry.relayFallbackSecondsLeft
	}
	const showRelayFallback = () => relayFallbackSecondsLeft() != null
	const hasConnectionCopy = () =>
		props.entry.side !== 'host' && !showRelayFallback()
	const hasConnectionEntryLayout = () => {
		const entry = guestJoin()
		return (
			entry?.status === 'needs-invite' || entry?.status === 'creating-reply'
		)
	}
	const [hostInviteMode, setHostInviteMode] =
		createSignal<HostInviteMode>('link')

	return (
		<article
			class="portrait-card utility-card connection-card"
			classList={{ 'is-entry': hasConnectionEntryLayout() }}
		>
			<div class="connection-top">
				<header class="utility-header">
					<Switch fallback={<strong>{connectionHeading(props.entry)}</strong>}>
						<Match when={showRelayFallback()}>
							<div class="connection-finding-header">
								<strong>reply code</strong>
								<p>Found the host. Keep this tab open to join the room.</p>
								<RelayFallbackControl
									secondsLeft={relayFallbackSecondsLeft() ?? 0}
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
								<span aria-hidden="true">|</span>
								<button
									type="button"
									aria-pressed={hostInviteMode() === 'code' ? 'true' : 'false'}
									onClick={() => setHostInviteMode('code')}
								>
									with code
								</button>
							</div>
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
									props.entry.status === 'discovering-host' &&
									props.canClaimInviteAsHost
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
									props.entry.status === 'discovering-host' &&
									hostReachable()
								}
							>
								<p>Found the host. Keep this tab open to join the room.</p>
							</Match>
							<Match
								when={
									props.entry.side === 'guest' &&
									props.entry.status === 'discovering-host'
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
								<p class="connection-issue" role="status">
									{entryIssueCopy[issue()]}
								</p>
							)}
						</Show>
					</div>
				</Show>
			</div>
			<Switch>
				<Match when={props.entry.side === 'closed'}>
					<div class="card-actions connection-side-switch connection-action">
						<button type="button" onClick={props.onBecomeHost}>
							start a new room
						</button>
						<Show when={props.canBecomeGuest}>
							<button type="button" onClick={props.onBecomeGuest}>
								join someone else
							</button>
						</Show>
					</div>
				</Match>
				<Match when={hostInvite()}>
					{(entry) => (
						<HostInvitePane
							entry={entry()}
							canBecomeGuest={props.canBecomeGuest}
							mode={hostInviteMode()}
							onAcceptReplyCode={props.onAcceptReplyCode}
							onBecomeGuest={props.onBecomeGuest}
							onSetReplyText={props.onSetReplyText}
						/>
					)}
				</Match>
				<Match when={guestJoin()}>
					{(entry) => (
						<GuestInvitePane
							canClaimInviteAsHost={props.canClaimInviteAsHost}
							entry={entry()}
							onBecomeHost={props.onBecomeHost}
							onClaimInviteLinkAsHost={props.onClaimInviteLinkAsHost}
							onJoinInvite={props.onJoinInvite}
							onSetInviteText={props.onSetInviteText}
						/>
					)}
				</Match>
			</Switch>
		</article>
	)
}
