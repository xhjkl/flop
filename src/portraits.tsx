import {
	createEffect,
	createSignal,
	For,
	type JSX,
	Match,
	onCleanup,
	Show,
	Switch,
} from 'solid-js'
import { hueFromSeed, themeHueFromSeed } from './hue'
import type { SelfMedia, SelfMediaStatus } from './self-media'
import type {
	BlipComposerState,
	PeerConnectionState,
	PeerMediaState,
	PortraitActivityState,
	PortraitFileState,
} from './state'
import { createPulse } from './ui/pulse'

const SelfMediaStatusLabel = (props: { status: SelfMediaStatus }) => {
	return (
		<Switch fallback={null}>
			<Match when={props.status === 'missing'}>
				<small>device missing</small>
			</Match>
			<Match when={props.status === 'unsupported'}>
				<small>unsupported</small>
			</Match>
			<Match when={props.status === 'error'}>
				<small>capture failed</small>
			</Match>
		</Switch>
	)
}

const hasLiveSelfPreview = (media: SelfMedia) => {
	return media.status === 'live' && media.outboundStream != null
}

const hasActiveSelfPreview = (media: SelfMedia) => {
	return (
		media.status === 'live' &&
		media.outboundStream != null &&
		((media.screenEnabled && media.screenStream != null) ||
			(media.cameraAvailable && media.cameraEnabled))
	)
}

const hasSelfMediaWarning = (status: SelfMediaStatus) => {
	return (
		status === 'denied' ||
		status === 'missing' ||
		status === 'unsupported' ||
		status === 'error'
	)
}

const VideoStream = (props: {
	active?: boolean
	class: string
	mirrored?: boolean
	muted?: boolean
	stream?: MediaStream | null
}) => {
	let video: HTMLVideoElement | null = null

	createEffect(() => {
		const stream = props.stream ?? null
		const element = video
		if (element == null) return

		if (element.srcObject !== stream) {
			element.srcObject = stream
		}
		if (stream != null && props.active !== false) {
			void element.play().catch(() => {})
		}
	})

	onCleanup(() => {
		if (video == null) return

		video.srcObject = null
	})

	const hidden = () => (props.stream ?? null) == null || props.active === false

	return (
		<video
			ref={(element) => {
				video = element
			}}
			class={`media-video ${props.class}`}
			classList={{
				'is-hidden': hidden(),
				'is-mirrored': props.mirrored === true,
			}}
			autoplay
			muted={props.muted}
			playsinline
		/>
	)
}

export const Room = (props: {
	themeSeed?: string | null
	children?: JSX.Element
}) => {
	return (
		// The whole app is one gallery strip; every flow should earn its portrait.
		<main
			class="portrait-app"
			style={{ '--h': `${themeHueFromSeed(props.themeSeed ?? null)}` }}
		>
			<section class="portrait-strip scrollbarless" aria-label="room cards">
				{props.children}
			</section>
		</main>
	)
}

const fileChipLabel = (file: PortraitFileState) => {
	switch (file.state) {
		case 'sending':
			return `sending ${file.name}`
		case 'receiving':
			return `receiving ${file.name}`
		case 'error':
			return `failed ${file.name}`
		case 'ready':
			return file.name
	}
}

const fileProgress = (file: PortraitFileState) => {
	if (file.state !== 'sending' && file.state !== 'receiving') return 100
	if (file.size <= 0) return 100

	return Math.min(100, Math.round((file.transferredBytes / file.size) * 100))
}

const FileChip = (props: { file: PortraitFileState }) => {
	const body = () => (
		<>
			<span>{fileChipLabel(props.file)}</span>
			<Show
				when={
					props.file.state === 'sending' || props.file.state === 'receiving'
				}
			>
				<i style={{ '--progress': `${fileProgress(props.file)}%` }} />
			</Show>
		</>
	)

	return (
		// Files live under the person who announced them; that keeps transfer state social, not panel-shaped.
		<Show
			when={props.file.url != null}
			fallback={
				<span
					class="file-chip glass-pill"
					classList={{ 'is-error': props.file.state === 'error' }}
				>
					{body()}
				</span>
			}
		>
			<a
				class="file-chip glass-pill"
				classList={{ 'is-error': props.file.state === 'error' }}
				href={props.file.url ?? ''}
				download={props.file.name}
			>
				{body()}
			</a>
		</Show>
	)
}

const PortraitActivity = (props: {
	activity: PortraitActivityState
	showBlip?: boolean
}) => {
	const blip = () =>
		props.showBlip !== false ? props.activity.blip?.trim() || null : null

	return (
		<Show when={props.activity.files.length > 0 || blip() != null}>
			<div class="portrait-activity">
				<For each={props.activity.files}>
					{(file) => <FileChip file={file} />}
				</For>
				<Show when={blip()}>
					{(text) => <p class="portrait-blip glass-pill">{text()}</p>}
				</Show>
			</div>
		</Show>
	)
}

const BlipComposer = (props: {
	canSend: boolean
	composer: BlipComposerState
	onSend: () => void
	onDismissIssue: () => void
	onSetText: (text: string) => void
	showWhenIdle?: boolean
}) => {
	const [dirty, setDirty] = createSignal(false)
	const [editing, setEditing] = createSignal(false)
	const committed = createPulse(520)

	const markCommitted = () => {
		setDirty(false)
		setEditing(false)
		committed.trigger()
	}

	const send = () => {
		if (!props.canSend || !dirty()) {
			setEditing(false)
			return
		}

		props.onSend()
		markCommitted()
	}

	const submit = (event: SubmitEvent) => {
		event.preventDefault()
		send()
	}

	const submitEnter = (event: KeyboardEvent) => {
		if (event.key !== 'Enter' || event.isComposing) return
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
		event.preventDefault()
		send()
	}

	const visible = () => {
		return (
			props.showWhenIdle ||
			props.canSend ||
			props.composer.issue != null ||
			props.composer.text.trim() !== ''
		)
	}

	return (
		<Show when={visible()}>
			<form class="blip-composer" onSubmit={submit}>
				<Show when={props.composer.issue}>
					{(issue) => (
						<button
							type="button"
							class="blip-issue"
							aria-label={`Dismiss notice: ${issue()}`}
							onClick={props.onDismissIssue}
						>
							<span class="blip-issue-mark" aria-hidden="true">
								i
							</span>
							<span class="blip-issue-text">{issue()}</span>
							<span class="blip-issue-dismiss" aria-hidden="true">
								×
							</span>
						</button>
					)}
				</Show>
				<Show
					when={
						props.showWhenIdle ||
						props.canSend ||
						props.composer.text.trim() !== ''
					}
				>
					<textarea
						value={props.composer.text}
						aria-label="blip"
						enterkeyhint="done"
						placeholder="tap to edit blip"
						rows={1}
						class="blip-composer-input glass-pill"
						classList={{
							'is-editing': editing(),
							'is-committed': committed.active(),
						}}
						onFocus={() => setEditing(true)}
						onInput={(event) => {
							setDirty(true)
							setEditing(true)
							committed.clear()
							props.onSetText(event.currentTarget.value)
						}}
						onKeyDown={submitEnter}
						onBlur={send}
						disabled={!props.canSend}
					/>
				</Show>
			</form>
		</Show>
	)
}

export const PersonCard = (props: {
	activity: PortraitActivityState
	colorSeed: string
	mediaState?: PeerMediaState | null
	mediaStream?: MediaStream | null
	connectionState: PeerConnectionState
}) => {
	const videoActive = () =>
		props.mediaStream != null &&
		(props.mediaState == null ||
			props.mediaState.cameraEnabled ||
			props.mediaState.screenEnabled)

	return (
		<article
			class="portrait-card person-card"
			classList={{ 'is-live': props.connectionState === 'live' }}
		>
			<div
				class="portrait-face person-face"
				classList={{
					'has-video': videoActive(),
					'is-empty': !videoActive(),
				}}
				style={{ '--card-h': `${hueFromSeed(props.colorSeed)}` }}
			>
				<VideoStream
					active={videoActive()}
					class="remote-video"
					stream={props.mediaStream ?? null}
				/>
				<div class="person-activity-shell">
					<PortraitActivity activity={props.activity} />
				</div>
			</div>
		</article>
	)
}

export const SelfMediaCard = (props: {
	activity: PortraitActivityState
	canBlip: boolean
	blipComposer: BlipComposerState
	media: SelfMedia
	title?: string
	children?: JSX.Element
	actions?: JSX.Element
	onSendBlip: () => void
	onDismissBlipIssue: () => void
	onSetBlipText: (text: string) => void
	onToggleCamera?: () => void
	onToggleMicrophone?: () => void
	onToggleScreen: () => void
}) => {
	return (
		<article
			class="portrait-card self-card"
			classList={{
				'is-live': props.media.status === 'live',
				'has-preview': hasLiveSelfPreview(props.media),
				'is-setup': props.media.status !== 'live',
				'is-warning': hasSelfMediaWarning(props.media.status),
			}}
		>
			<Show when={hasLiveSelfPreview(props.media)}>
				<div class="portrait-face self-portrait-face">
					<VideoStream
						active={hasActiveSelfPreview(props.media)}
						class="self-video"
						mirrored={!props.media.screenEnabled}
						muted
						stream={props.media.outboundStream}
					/>
				</div>
			</Show>
			<Show
				when={props.media.status === 'live'}
				fallback={
					<div class="self-card-body">
						<Show
							when={(props.title ?? '').trim() !== '' || props.children != null}
						>
							<div class="self-copy-shell">
								<Show when={(props.title ?? '').trim() !== ''}>
									<header class="utility-header">
										<strong>{props.title}</strong>
										<SelfMediaStatusLabel status={props.media.status} />
									</header>
								</Show>
								<Show when={props.children != null}>
									<div class="self-card-copy">{props.children}</div>
								</Show>
							</div>
						</Show>
						<PortraitActivity activity={props.activity} showBlip={false} />
						<BlipComposer
							canSend={props.canBlip}
							composer={props.blipComposer}
							onSend={props.onSendBlip}
							onDismissIssue={props.onDismissBlipIssue}
							onSetText={props.onSetBlipText}
						/>
						<Show when={props.actions != null}>
							<div class="card-actions">{props.actions}</div>
						</Show>
					</div>
				}
			>
				<div class="self-live-shell">
					<div class="self-screen-control">
						<ToggleButton
							label="scr"
							enabled={props.media.screenEnabled}
							disabled={
								!props.media.screenAvailable || props.media.screenRequesting
							}
							onPress={props.onToggleScreen}
						/>
					</div>
					<PortraitActivity activity={props.activity} showBlip={false} />
					<BlipComposer
						canSend={props.canBlip}
						composer={props.blipComposer}
						onSend={props.onSendBlip}
						onDismissIssue={props.onDismissBlipIssue}
						onSetText={props.onSetBlipText}
						showWhenIdle
					/>
					<div class="self-live-controls">
						<Show when={props.onToggleCamera}>
							{(onToggleCamera) => (
								<ToggleButton
									label="cam"
									enabled={props.media.cameraEnabled}
									disabled={!props.media.cameraAvailable}
									onPress={onToggleCamera()}
								/>
							)}
						</Show>
						<Show when={props.onToggleMicrophone}>
							{(onToggleMicrophone) => (
								<ToggleButton
									label="mic"
									enabled={props.media.microphoneEnabled}
									disabled={!props.media.microphoneAvailable}
									onPress={onToggleMicrophone()}
								/>
							)}
						</Show>
					</div>
				</div>
			</Show>
		</article>
	)
}

const ToggleButton = (props: {
	label: string
	enabled: boolean
	disabled?: boolean
	onPress: () => void
}) => {
	return (
		<button
			type="button"
			class="self-toggle"
			onClick={props.onPress}
			disabled={props.disabled ?? false}
			aria-pressed={props.enabled}
		>
			<span class="self-toggle-label">{props.label}</span>
			<span class="self-toggle-switch" aria-hidden="true">
				<span class="self-toggle-knob" />
			</span>
		</button>
	)
}
