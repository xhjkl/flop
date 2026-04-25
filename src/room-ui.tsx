import { createEffect, For, type JSX, Show } from 'solid-js'
import { hueFromSeed, themeHueFromSeed } from './hue'
import type {
	BlipComposerState,
	PeerState,
	PortraitActivityState,
	PortraitFileState,
} from './room-types'
import type { SelfMedia, SelfMediaStatus } from './self-media'

export type PressAction = {
	onPress?: () => void
	disabled?: boolean
}

export type CardAction = PressAction & {
	label: string
}

const peerStateLabels = {
	live: 'live',
	waiting: 'waiting',
} satisfies Record<PeerState, string>

const selfMediaStateLabels = {
	ready: '',
	requesting: 'requesting',
	live: '',
	denied: 'access denied',
	missing: 'device missing',
	unsupported: 'unsupported',
	error: 'capture failed',
} satisfies Record<SelfMediaStatus, string>

function initials(name: string) {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? '')
		.join('')
}

function hasLiveSelfPreview(media: SelfMedia) {
	return (
		media.status === 'live' &&
		media.stream != null &&
		media.cameraAvailable &&
		media.cameraEnabled
	)
}

export function CardActions(props: { actions: CardAction[] }) {
	if (props.actions.length === 0) return null

	return (
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

function BlipComposer(props: {
	canSend: boolean
	composer: BlipComposerState
	onSend: () => void
	onSetText: (text: string) => void
}) {
	function submit(event: SubmitEvent) {
		event.preventDefault()
		props.onSend()
	}

	return (
		<form class="blip-composer" onSubmit={submit}>
			<Show when={props.composer.issue}>
				{(issue) => <p class="blip-issue">{issue()}</p>}
			</Show>
			<Show when={props.canSend || props.composer.text.trim() !== ''}>
				<div>
					<input
						type="text"
						value={props.composer.text}
						placeholder={
							props.canSend ? 'write a blip' : 'connect before writing'
						}
						onInput={(event) => props.onSetText(event.currentTarget.value)}
						disabled={!props.canSend}
					/>
					<button
						type="submit"
						disabled={!props.canSend || props.composer.text.trim() === ''}
					>
						send
					</button>
				</div>
			</Show>
		</form>
	)
}

function SelfBlipComposer(props: {
	canSend?: boolean
	composer?: BlipComposerState
	onSend?: () => void
	onSetText?: (text: string) => void
}) {
	if (
		props.composer == null ||
		props.onSend == null ||
		props.onSetText == null
	) {
		return null
	}

	if (
		!(props.canSend ?? false) &&
		props.composer.issue == null &&
		props.composer.text.trim() === ''
	) {
		// No empty chat box before there is someone to talk to.
		return null
	}

	return (
		<BlipComposer
			canSend={props.canSend ?? false}
			composer={props.composer}
			onSend={props.onSend}
			onSetText={props.onSetText}
		/>
	)
}

export function PersonCard(props: {
	activity: PortraitActivityState
	colorSeed: string
	name: string
	state: PeerState
}) {
	return (
		<article class="portrait-card person-card" data-state={props.state}>
			<div
				class="portrait-face"
				style={{ '--card-h': `${hueFromSeed(props.colorSeed)}` }}
			>
				<div class="portrait-initials">{initials(props.name)}</div>
			</div>
			<div class="portrait-meta">
				<strong>{props.name}</strong>
				<PortraitActivity activity={props.activity} />
				<small>{peerStateLabels[props.state]}</small>
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
	let video: HTMLVideoElement | null = null

	createEffect(() => {
		if (video == null) return

		if (hasLiveSelfPreview(props.media)) {
			// The local preview is a mirror first; remote publishing can build on the same portrait.
			video.srcObject = props.media.stream
			void video.play().catch(() => null)
			return
		}

		video.srcObject = null
	})

	return (
		<article
			class="portrait-card self-card"
			data-media-state={props.media.status}
			data-has-preview={hasLiveSelfPreview(props.media) ? 'true' : 'false'}
		>
			<Show when={hasLiveSelfPreview(props.media)}>
				<div class="portrait-face self-portrait-face">
					<video
						ref={(element) => {
							video = element
						}}
						class="self-video"
						autoplay
						muted
						playsinline
					/>
					<div class="portrait-monogram">YOU</div>
				</div>
			</Show>
			<div class="self-card-body">
				<Show
					when={props.media.status !== 'live'}
					fallback={
						<div class="self-live-shell">
							<PortraitActivity
								activity={props.activity ?? { blip: null, files: [] }}
							/>
							<SelfBlipComposer
								canSend={props.canBlip}
								composer={props.blipComposer}
								onSend={props.onSendBlip}
								onSetText={props.onSetBlipText}
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
					<PortraitActivity
						activity={props.activity ?? { blip: null, files: [] }}
					/>
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
