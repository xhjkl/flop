import {
	createEffect,
	createSignal,
	For,
	type JSX,
	onCleanup,
	Show,
} from 'solid-js'
import { hueFromSeed, themeHueFromSeed } from './hue'
import { type SelfMedia, selfMediaDeviceTrack } from './room/media'
import type {
	FileTransferIssue,
	RoomPeer,
	SharedFile,
} from './room/participant'
import { fileTransferIssueCopy } from './ui/copy'
import { createPulse } from './ui/pulse'
import { viewfinderObjectPosition } from './viewfinder'

const hasActiveSelfPreview = (media: SelfMedia) => {
	return (
		media.status === 'live' &&
		(media.screen.status === 'sharing' ||
			selfMediaDeviceTrack(media, 'video')?.enabled === true)
	)
}

const hasSelfMediaWarning = (status: SelfMedia['status']) => {
	return (
		status === 'busy' ||
		status === 'denied' ||
		status === 'interrupted' ||
		status === 'missing' ||
		status === 'unsupported' ||
		status === 'error'
	)
}

const selfMediaNotice = (media: SelfMedia) => {
	let title: string
	let issue: string
	switch (media.status) {
		case 'idle':
			return {
				actionDisabled: false,
				actionLabel: 'enable cam and mic',
				paragraphs: [
					'Send an invite to another device. Once connected, drop files here to send them directly. Turn on camera and microphone when you want peers to see or hear you.',
				],
				title: 'welcome to flop',
			}
		case 'requesting':
			return {
				actionDisabled: true,
				actionLabel: 'waiting for permission',
				paragraphs: [
					'Your browser should be asking for permission now. Once allowed, this card becomes your live portrait.',
				],
				title: 'Allow cam and mic',
			}
		case 'denied':
			title = 'Access denied'
			issue =
				'Camera or microphone access was denied. Allow access in your browser, then try again.'
			break
		case 'missing':
			title = 'No devices found'
			issue =
				'No working camera or microphone was found. Connect one and try again.'
			break
		case 'interrupted':
			title = 'Media stopped'
			issue =
				'The camera or microphone stopped. Check the device or browser permission, then try again.'
			break
		case 'unsupported':
			title = 'Browser unsupported'
			issue = 'This browser cannot open camera and microphone here.'
			break
		case 'busy':
			title = 'Could not start media'
			issue =
				'This browser could not start camera or microphone. Another app may already be using a device.'
			break
		case 'error':
			title = 'Could not start media'
			issue = 'This browser could not open camera and microphone.'
			break
		case 'live':
			return null
	}

	return {
		actionDisabled: false,
		actionLabel: 'try again',
		paragraphs: [
			issue,
			'After changing your browser or device setting, try again. You can still use the room without camera or microphone.',
		],
		title,
	}
}

type VideoPointerEvent = PointerEvent & { currentTarget: HTMLVideoElement }

const VideoStream = (props: {
	active: boolean
	class: string
	mirrored?: boolean
	muted?: boolean
	stream: MediaStream | null
}) => {
	let video: HTMLVideoElement | null = null
	let viewfinderPointer: number | null = null

	/** Visible crop aligned with the held pointer. */
	const moveViewfinder = (event: VideoPointerEvent) => {
		if (event.pointerId !== viewfinderPointer) return

		event.currentTarget.style.objectPosition = viewfinderObjectPosition(
			event.clientX,
			event.clientY,
			event.currentTarget.getBoundingClientRect(),
			props.mirrored === true,
		)
	}

	const startViewfinder = (event: VideoPointerEvent) => {
		if (!event.isPrimary || event.button !== 0 || viewfinderPointer != null) {
			return
		}

		viewfinderPointer = event.pointerId
		// Capture preserves the hold until release even when the pointer leaves the card.
		event.currentTarget.setPointerCapture(event.pointerId)
		moveViewfinder(event)
	}

	const stopViewfinder = (event: VideoPointerEvent) => {
		if (event.pointerId !== viewfinderPointer) return

		viewfinderPointer = null
		event.currentTarget.style.removeProperty('object-position')
	}

	createEffect(() => {
		const stream = props.stream ?? null
		const element = video
		if (element == null) return

		if (element.srcObject !== stream) {
			element.srcObject = stream
		}
		if (stream != null && props.active) {
			void element.play().catch(() => {})
		}
	})

	onCleanup(() => {
		if (video == null) return

		video.srcObject = null
	})

	const hidden = () => props.stream == null || !props.active

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
			onPointerDown={startViewfinder}
			onPointerMove={moveViewfinder}
			onPointerUp={stopViewfinder}
			onPointerCancel={stopViewfinder}
			onLostPointerCapture={stopViewfinder}
		/>
	)
}

export const PortraitStrip = (props: {
	themeSeed: string
	children?: JSX.Element
}) => {
	return (
		// One persistent scroll container owns every room card.
		<main
			class="portrait-app"
			style={{ '--h': `${themeHueFromSeed(props.themeSeed)}` }}
		>
			<section class="portrait-strip scrollbarless" aria-label="room cards">
				{props.children}
			</section>
		</main>
	)
}

const fileChipLabel = (file: SharedFile) => {
	switch (file.state) {
		case 'sending':
			return `sending ${file.name}`
		case 'receiving':
			return `receiving ${file.name}`
		case 'failed':
			return `failed ${file.name}`
		case 'download':
		case 'sent':
			return file.name
	}
}

const fileProgress = (file: SharedFile) => {
	if (file.state !== 'sending' && file.state !== 'receiving') return 100
	if (file.size <= 0) return 100

	return Math.min(100, Math.round((file.transferredBytes / file.size) * 100))
}

const FileChip = (props: { file: SharedFile }) => {
	const body = () => (
		<>
			<span>{fileChipLabel(props.file)}</span>
			<Show
				when={
					props.file.state === 'sending' || props.file.state === 'receiving'
				}
			>
				<i
					role="progressbar"
					aria-label={`${props.file.name} transfer progress`}
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={fileProgress(props.file)}
					style={{ '--progress': `${fileProgress(props.file)}%` }}
				/>
			</Show>
		</>
	)

	return (
		<Show
			when={props.file.state === 'download' ? props.file : null}
			fallback={
				<span
					class="file-chip glass-pill"
					classList={{ 'is-error': props.file.state === 'failed' }}
				>
					{body()}
				</span>
			}
		>
			{(file) => (
				<a
					class="file-chip glass-pill"
					href={file().url}
					download={file().name}
				>
					{body()}
				</a>
			)}
		</Show>
	)
}

const PortraitActivity = (props: {
	blip?: string | null
	files: SharedFile[]
}) => {
	const blip = () => props.blip?.trim() || null

	return (
		<Show when={props.files.length > 0 || blip() != null}>
			<div class="portrait-activity">
				{/* Progress replaces file snapshots; transfer identity keeps each chip mounted. */}
				<For each={props.files.map((file) => file.id)}>
					{(id) => (
						<Show when={props.files.find((file) => file.id === id)}>
							{(file) => <FileChip file={file()} />}
						</Show>
					)}
				</For>
				<Show when={blip()}>
					{(text) => <p class="portrait-blip glass-pill">{text()}</p>}
				</Show>
			</div>
		</Show>
	)
}

const BlipComposer = (props: {
	draft: string
	fileTransferIssue: FileTransferIssue | null
	onSend: () => void
	onDismissIssue: () => void
	onSetText: (text: string) => void
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
		if (!dirty()) {
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

	return (
		<form class="blip-composer" onSubmit={submit}>
			<Show when={props.fileTransferIssue}>
				{(issue) => {
					const copy = () => fileTransferIssueCopy[issue()]
					return (
						<button
							type="button"
							class="file-transfer-issue"
							aria-label={`Dismiss notice: ${copy()}`}
							onClick={props.onDismissIssue}
						>
							<span class="file-transfer-issue-mark" aria-hidden="true">
								i
							</span>
							<span class="file-transfer-issue-text">{copy()}</span>
							<span class="file-transfer-issue-dismiss" aria-hidden="true">
								×
							</span>
						</button>
					)
				}}
			</Show>
			<textarea
				value={props.draft}
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
			/>
		</form>
	)
}
export const PeerPortraitCard = (props: { peer: RoomPeer }) => {
	const connection = () => props.peer.connection
	const hasVideoTrack = () =>
		connection()
			?.mediaStream?.getVideoTracks()
			.some((track) => track.readyState !== 'ended') === true
	const videoActive = () =>
		hasVideoTrack() &&
		(connection()?.mediaPresence == null ||
			connection()?.mediaPresence?.cameraEnabled === true ||
			connection()?.mediaPresence?.screenEnabled === true)

	return (
		<article
			class="portrait-card peer-card"
			classList={{ 'is-live': connection()?.connected === true }}
		>
			<div
				class="portrait-face peer-face"
				classList={{
					'has-video': videoActive(),
					'is-empty': !videoActive(),
				}}
				style={{ '--card-h': `${hueFromSeed(props.peer.id)}` }}
			>
				<VideoStream
					active={videoActive()}
					class="remote-video"
					stream={connection()?.mediaStream ?? null}
				/>
				<div class="peer-activity-shell">
					<PortraitActivity blip={props.peer.blip} files={props.peer.files} />
				</div>
			</div>
		</article>
	)
}

/** Keyboard- and touch-accessible counterpart to room-wide file dropping. */
const FilePickerButton = (props: { onSelect: (files: File[]) => void }) => {
	let input: HTMLInputElement | null = null
	const selected = (event: Event & { currentTarget: HTMLInputElement }) => {
		const files = Array.from(event.currentTarget.files ?? [])
		event.currentTarget.value = ''
		if (files.length > 0) props.onSelect(files)
	}

	return (
		<>
			<button
				type="button"
				class="self-toggle self-file-picker"
				aria-label="send files"
				onClick={() => input?.click()}
			>
				<span class="self-toggle-label">file</span>
				<span class="self-file-picker-icon" aria-hidden="true">
					↑
				</span>
			</button>
			<input
				ref={(element) => {
					input = element
				}}
				type="file"
				multiple
				hidden
				onChange={selected}
			/>
		</>
	)
}

export const SelfPortraitCard = (props: {
	blipDraft: string
	fileTransferIssue: FileTransferIssue | null
	files: SharedFile[]
	media: SelfMedia
	onDismissFileTransferIssue: () => void
	onEnableSelfMedia: () => void
	onSendFiles: (files: File[]) => void
	onSendBlip: () => void
	onSetBlipDraft: (text: string) => void
	onToggleCamera: () => void
	onToggleMicrophone: () => void
	onToggleScreen: () => void
}) => {
	const notice = () => selfMediaNotice(props.media)
	const liveMedia = () => (props.media.status === 'live' ? props.media : null)
	const camera = () => selfMediaDeviceTrack(props.media, 'video')
	const microphone = () => selfMediaDeviceTrack(props.media, 'audio')
	const screenStatus = () => liveMedia()?.screen.status ?? null

	return (
		<article
			class="portrait-card self-card"
			classList={{
				'is-live': props.media.status === 'live',
				'is-setup': props.media.status !== 'live',
				'is-warning': hasSelfMediaWarning(props.media.status),
			}}
		>
			<Show when={props.media.status === 'live'}>
				<div class="portrait-face self-portrait-face">
					<VideoStream
						active={hasActiveSelfPreview(props.media)}
						class="self-video"
						mirrored={liveMedia()?.screen.status !== 'sharing'}
						muted
						stream={liveMedia()?.publishedStream ?? null}
					/>
				</div>
			</Show>
			<div
				classList={{
					'self-card-body': liveMedia() == null,
					'self-live-shell': liveMedia() != null,
				}}
			>
				<Show when={notice()}>
					{(notice) => (
						<div class="self-copy-shell">
							<header class="utility-header">
								<strong>{notice().title}</strong>
							</header>
							<div class="self-card-copy">
								<For each={notice().paragraphs}>
									{(paragraph) => <p>{paragraph}</p>}
								</For>
							</div>
						</div>
					)}
				</Show>
				<div
					class="self-media-actions"
					classList={{
						'card-actions': liveMedia() == null,
						'self-screen-control': liveMedia() != null,
					}}
				>
					<FilePickerButton onSelect={props.onSendFiles} />
					<Show
						when={liveMedia()}
						fallback={
							<button
								type="button"
								onClick={props.onEnableSelfMedia}
								disabled={notice()?.actionDisabled ?? true}
							>
								{notice()?.actionLabel ?? 'enable cam and mic'}
							</button>
						}
					>
						<ToggleButton
							accessibleName="screen sharing"
							label="scr"
							enabled={screenStatus() === 'sharing'}
							disabled={
								screenStatus() !== 'available' && screenStatus() !== 'sharing'
							}
							onPress={props.onToggleScreen}
						/>
					</Show>
				</div>
				<PortraitActivity files={props.files} />
				<BlipComposer
					draft={props.blipDraft}
					fileTransferIssue={props.fileTransferIssue}
					onSend={props.onSendBlip}
					onDismissIssue={props.onDismissFileTransferIssue}
					onSetText={props.onSetBlipDraft}
				/>
				<Show when={liveMedia()}>
					<div class="self-live-controls">
						<ToggleButton
							accessibleName="camera"
							label="cam"
							enabled={camera()?.enabled === true}
							disabled={camera() == null}
							onPress={props.onToggleCamera}
						/>
						<ToggleButton
							accessibleName="microphone"
							label="mic"
							enabled={microphone()?.enabled === true}
							disabled={microphone() == null}
							onPress={props.onToggleMicrophone}
						/>
					</div>
				</Show>
			</div>
		</article>
	)
}

const ToggleButton = (props: {
	accessibleName: string
	label: string
	enabled: boolean
	disabled: boolean
	onPress: () => void
}) => {
	return (
		<button
			type="button"
			class="self-toggle"
			onClick={props.onPress}
			disabled={props.disabled}
			aria-label={props.accessibleName}
			aria-pressed={props.enabled}
		>
			<span class="self-toggle-label">{props.label}</span>
			<span class="self-toggle-switch" aria-hidden="true">
				<span class="self-toggle-knob" />
			</span>
		</button>
	)
}
