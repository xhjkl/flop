import {
	createEffect,
	createSignal,
	For,
	type JSX,
	onCleanup,
	Show,
} from 'solid-js'
import { hueFromSeed, themeHueFromSeed } from './hue'
import type { SelfMedia, SelfMediaStatus } from './self-media'
import type {
	BlipComposerState,
	PeerMediaState,
	PeerState,
	PortraitActivityState,
	PortraitFileState,
} from './state'

export type PressAction = {
	onPress?: () => void
	disabled?: boolean
}

export type CardAction = PressAction & {
	label: string
}

const selfMediaStateLabels = {
	ready: '',
	requesting: 'requesting',
	live: '',
	denied: 'access denied',
	missing: 'device missing',
	unsupported: 'unsupported',
	error: 'capture failed',
} satisfies Record<SelfMediaStatus, string>

function hasLiveSelfPreview(media: SelfMedia) {
	return media.status === 'live' && media.stream != null
}

function hasActiveSelfPreview(media: SelfMedia) {
	return (
		media.status === 'live' &&
		media.stream != null &&
		media.cameraAvailable &&
		media.cameraEnabled
	)
}

function describeStream(stream: MediaStream | null) {
	return {
		streamId: stream?.id ?? null,
		tracks:
			stream?.getTracks().map((track) => ({
				enabled: track.enabled,
				id: track.id,
				kind: track.kind,
				muted: track.muted,
				readyState: track.readyState,
			})) ?? [],
	}
}

function describeVideoElement(element: HTMLVideoElement) {
	return {
		ended: element.ended,
		hasSrcObject: element.srcObject != null,
		muted: element.muted,
		networkState: element.networkState,
		paused: element.paused,
		readyState: element.readyState,
		videoHeight: element.videoHeight,
		videoWidth: element.videoWidth,
	}
}

function mediaDebugValue(_key: string, value: unknown): unknown {
	return value instanceof Error
		? { message: value.message, name: value.name }
		: value
}

function mediaDebug(
	event: string,
	details: Record<string, unknown> = {},
	level: 'debug' | 'warn' = 'debug',
) {
	console[level](
		'[flop:media]',
		JSON.stringify({ event, ...details }, mediaDebugValue),
	)
}

function playVideo(
	label: string,
	element: HTMLVideoElement,
	stream: MediaStream,
) {
	void element
		.play()
		.then(() => {
			mediaDebug('video.play.ok', {
				...describeVideoElement(element),
				label,
				...describeStream(stream),
			})
		})
		.catch((error: unknown) => {
			mediaDebug(
				'video.play.failed',
				{
					error,
					...describeVideoElement(element),
					label,
					...describeStream(stream),
				},
				'warn',
			)
		})
}

function StreamVideo(props: {
	active?: boolean
	class: string
	label: string
	muted?: boolean
	stream?: MediaStream | null
}) {
	let video: HTMLVideoElement | null = null

	createEffect(() => {
		const stream = props.stream ?? null
		const element = video
		if (element == null) return

		if (element.srcObject !== stream) {
			element.srcObject = stream
			mediaDebug('video.srcObject', {
				...describeVideoElement(element),
				label: props.label,
				...describeStream(stream),
			})
		}
		if (stream != null && props.active !== false) {
			playVideo(props.label, element, stream)
		}
	})

	onCleanup(() => {
		if (video == null) return

		video.srcObject = null
	})

	return (
		<video
			ref={(element) => {
				video = element
			}}
			class={props.class}
			data-active={
				(props.stream ?? null) != null && props.active !== false
					? 'true'
					: 'false'
			}
			autoplay
			muted={props.muted}
			onCanPlay={() => {
				if (video == null) return
				mediaDebug('video.canplay', {
					...describeVideoElement(video),
					label: props.label,
				})
			}}
			onError={() => {
				if (video == null) return
				mediaDebug(
					'video.error',
					{
						...describeVideoElement(video),
						label: props.label,
						message: video.error?.message ?? null,
					},
					'warn',
				)
			}}
			onLoadedMetadata={() => {
				if (video == null) return
				mediaDebug('video.loadedmetadata', {
					...describeVideoElement(video),
					label: props.label,
				})
			}}
			onPlaying={() => {
				if (video == null) return
				mediaDebug('video.playing', {
					...describeVideoElement(video),
					label: props.label,
				})
			}}
			playsinline
		/>
	)
}

export function CardActions(props: { actions: CardAction[] }) {
	return (
		<Show when={props.actions.length > 0}>
			<div class="card-actions">
				<For each={props.actions}>
					{(action) => (
						<button
							type="button"
							onClick={() => action.onPress?.()}
							disabled={action.disabled ?? false}
						>
							{action.label}
						</button>
					)}
				</For>
			</div>
		</Show>
	)
}

export function Room(props: {
	themeSeed?: string | null
	children?: JSX.Element
}) {
	return (
		// The whole app is one gallery strip; every flow should earn its portrait.
		<main
			class="portrait-app"
			style={{ '--h': `${themeHueFromSeed(props.themeSeed ?? null)}` }}
		>
			<section class="portrait-strip" aria-label="room cards">
				{props.children}
			</section>
		</main>
	)
}

function fileChipLabel(file: PortraitFileState) {
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

function FileChip(props: { file: PortraitFileState }) {
	const body = () => (
		<>
			<span>{fileChipLabel(props.file)}</span>
			<Show
				when={
					props.file.state === 'sending' || props.file.state === 'receiving'
				}
			>
				<i style={{ '--progress': `${props.file.progress}%` }} />
			</Show>
		</>
	)

	return (
		// Files live under the person who announced them; that keeps transfer state social, not panel-shaped.
		<Show
			when={props.file.url != null}
			fallback={
				<span class="file-chip" data-file-state={props.file.state}>
					{body()}
				</span>
			}
		>
			<a
				class="file-chip"
				data-file-state={props.file.state}
				href={props.file.url ?? ''}
				download={props.file.name}
			>
				{body()}
			</a>
		</Show>
	)
}

function PortraitActivity(props: { activity: PortraitActivityState }) {
	return (
		<Show
			when={
				props.activity.files.length > 0 ||
				(props.activity.blip ?? '').trim() !== ''
			}
		>
			<div class="portrait-activity">
				<For each={props.activity.files}>
					{(file) => <FileChip file={file} />}
				</For>
				<Show when={props.activity.blip}>
					{(blip) => <p class="portrait-blip">{blip()}</p>}
				</Show>
			</div>
		</Show>
	)
}

function filesActivity(activity: PortraitActivityState | undefined) {
	return { blip: null, files: activity?.files ?? [] }
}

function BlipComposer(props: {
	canSend: boolean
	composer: BlipComposerState
	onSend: () => void
	onSetText: (text: string) => void
	showWhenIdle?: boolean
}) {
	let committedTimeout: ReturnType<typeof setTimeout> | null = null
	const [dirty, setDirty] = createSignal(false)
	const [editing, setEditing] = createSignal(false)
	const [committed, setCommitted] = createSignal(false)

	function markCommitted() {
		setDirty(false)
		setEditing(false)
		setCommitted(true)
		if (committedTimeout != null) clearTimeout(committedTimeout)
		committedTimeout = setTimeout(() => setCommitted(false), 520)
	}

	function send() {
		if (!props.canSend || !dirty()) {
			setEditing(false)
			return
		}

		props.onSend()
		markCommitted()
	}

	function submit(event: SubmitEvent) {
		event.preventDefault()
		send()
	}

	function submitEnter(event: KeyboardEvent) {
		if (event.key !== 'Enter' || event.isComposing) return
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
		event.preventDefault()
		send()
	}

	onCleanup(() => {
		if (committedTimeout != null) clearTimeout(committedTimeout)
	})

	return (
		<form class="blip-composer" onSubmit={submit}>
			<Show when={props.composer.issue}>
				{(issue) => <p class="blip-issue">{issue()}</p>}
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
					placeholder="tap to blip"
					rows={1}
					data-editing={editing() ? 'true' : 'false'}
					data-committed={committed() ? 'true' : 'false'}
					onFocus={() => setEditing(true)}
					onInput={(event) => {
						setDirty(true)
						setEditing(true)
						setCommitted(false)
						props.onSetText(event.currentTarget.value)
					}}
					onKeyDown={submitEnter}
					onBlur={send}
					disabled={!props.canSend}
				/>
			</Show>
		</form>
	)
}

function SelfBlipComposer(props: {
	canSend?: boolean
	composer?: BlipComposerState
	onSend?: () => void
	onSetText?: (text: string) => void
	showWhenIdle?: boolean
}) {
	const blipProps = () => {
		const composer = props.composer
		const onSend = props.onSend
		const onSetText = props.onSetText
		if (composer == null || onSend == null || onSetText == null) return null

		const visible =
			(props.canSend ?? false) ||
			(props.showWhenIdle ?? false) ||
			composer.issue != null ||
			composer.text.trim() !== ''
		if (!visible) return null

		return { composer, onSend, onSetText }
	}

	return (
		<Show when={blipProps()}>
			{(blip) => (
				<BlipComposer
					canSend={props.canSend ?? false}
					composer={blip().composer}
					onSend={blip().onSend}
					onSetText={blip().onSetText}
					showWhenIdle={props.showWhenIdle}
				/>
			)}
		</Show>
	)
}

export function PersonCard(props: {
	activity: PortraitActivityState
	colorSeed: string
	mediaState?: PeerMediaState | null
	mediaStream?: MediaStream | null
	state: PeerState
}) {
	const videoActive = () =>
		props.mediaStream != null && props.mediaState?.cameraEnabled !== false

	return (
		<article class="portrait-card person-card" data-state={props.state}>
			<div
				class="portrait-face person-face"
				data-has-video={videoActive() ? 'true' : 'false'}
				style={{ '--card-h': `${hueFromSeed(props.colorSeed)}` }}
			>
				<StreamVideo
					active={videoActive()}
					class="remote-video"
					label={`remote:${props.colorSeed}`}
					stream={props.mediaStream ?? null}
				/>
				<div class="person-activity-shell">
					<PortraitActivity activity={props.activity} />
				</div>
			</div>
		</article>
	)
}

export function SelfMediaCard(props: {
	activity?: PortraitActivityState
	canBlip?: boolean
	blipComposer?: BlipComposerState
	media: SelfMedia
	title?: string
	children?: JSX.Element
	actions?: CardAction[]
	cameraToggle?: PressAction
	microphoneToggle?: PressAction
	onSendBlip?: () => void
	onSetBlipText?: (text: string) => void
}) {
	return (
		<article
			class="portrait-card self-card"
			data-media-state={props.media.status}
			data-has-preview={hasLiveSelfPreview(props.media) ? 'true' : 'false'}
		>
			<Show when={hasLiveSelfPreview(props.media)}>
				<div class="portrait-face self-portrait-face">
					<StreamVideo
						active={hasActiveSelfPreview(props.media)}
						class="self-video"
						label="self"
						muted
						stream={props.media.stream}
					/>
				</div>
			</Show>
			<div class="self-card-body">
				<Show
					when={props.media.status !== 'live'}
					fallback={
						<div class="self-live-shell">
							<PortraitActivity activity={filesActivity(props.activity)} />
							<SelfBlipComposer
								canSend={props.canBlip}
								composer={props.blipComposer}
								onSend={props.onSendBlip}
								onSetText={props.onSetBlipText}
								showWhenIdle
							/>
							<div class="self-live-controls">
								<Show when={props.cameraToggle}>
									{(action) => (
										<ToggleButton
											label="cam"
											enabled={props.media.cameraEnabled}
											action={action()}
										/>
									)}
								</Show>
								<Show when={props.microphoneToggle}>
									{(action) => (
										<ToggleButton
											label="mic"
											enabled={props.media.microphoneEnabled}
											action={action()}
										/>
									)}
								</Show>
							</div>
						</div>
					}
				>
					<Show
						when={(props.title ?? '').trim() !== '' || props.children != null}
					>
						<div class="self-copy-shell">
							<Show when={(props.title ?? '').trim() !== ''}>
								<header class="utility-header">
									<strong>{props.title}</strong>
									<Show when={selfMediaStateLabels[props.media.status] !== ''}>
										<small>{selfMediaStateLabels[props.media.status]}</small>
									</Show>
								</header>
							</Show>
							<Show when={props.children != null}>
								<div class="self-card-copy">{props.children}</div>
							</Show>
						</div>
					</Show>
					<PortraitActivity activity={filesActivity(props.activity)} />
					<SelfBlipComposer
						canSend={props.canBlip}
						composer={props.blipComposer}
						onSend={props.onSendBlip}
						onSetText={props.onSetBlipText}
					/>
					<CardActions actions={props.actions ?? []} />
				</Show>
			</div>
		</article>
	)
}

function ToggleButton(props: {
	label: string
	enabled: boolean
	action: PressAction
}) {
	return (
		<button
			type="button"
			class="self-toggle"
			data-enabled={props.enabled ? 'true' : 'false'}
			onClick={() => props.action.onPress?.()}
			disabled={props.action.disabled ?? false}
			aria-pressed={props.enabled}
		>
			<span class="self-toggle-label">{props.label}</span>
			<span class="self-toggle-switch" aria-hidden="true">
				<span class="self-toggle-knob" />
			</span>
		</button>
	)
}
