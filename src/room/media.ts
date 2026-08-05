import type { MediaPresence } from '../protocol'
import type { RoomConnection } from './link'

type SelfMediaFailure =
	| 'busy'
	| 'denied'
	| 'error'
	| 'interrupted'
	| 'missing'
	| 'unsupported'

type ScreenCapture =
	| { status: 'available' | 'requesting' | 'unavailable'; stream: null }
	| { status: 'sharing'; stream: MediaStream }

type LiveSelfMedia = {
	/** Camera and microphone capture; its tracks own availability and enabled state. */
	deviceStream: MediaStream
	/** Stable composite stream used by both WebRTC senders and the local preview. */
	publishedStream: MediaStream
	screen: ScreenCapture
	status: 'live'
}

/** Local media is either absent, failed, or one live browser-owned capture. */
export type SelfMedia =
	| { status: 'idle' | 'requesting' | SelfMediaFailure }
	| LiveSelfMedia

const canCaptureDevices = () => {
	return typeof navigator !== 'undefined' && navigator.mediaDevices != null
}

const canCaptureScreen = () => {
	return (
		canCaptureDevices() &&
		typeof navigator.mediaDevices.getDisplayMedia === 'function'
	)
}

const idleScreenCapture = (): ScreenCapture => ({
	status: canCaptureScreen() ? 'available' : 'unavailable',
	stream: null,
})

const stopStream = (stream: MediaStream | null) => {
	for (const track of stream?.getTracks() ?? []) track.stop()
}

const stopSelfMedia = (media: SelfMedia) => {
	if (media.status !== 'live') return

	const tracks = new Set(media.deviceStream.getTracks())
	for (const track of media.publishedStream.getTracks()) tracks.add(track)
	for (const track of media.screen.stream?.getTracks() ?? []) tracks.add(track)
	for (const track of tracks) track.stop()
}

/** Current camera or microphone track; the browser track owns enabled state. */
export const selfMediaDeviceTrack = (
	media: SelfMedia,
	kind: 'audio' | 'video',
) => {
	if (media.status !== 'live') return null
	const tracks =
		kind === 'audio'
			? media.deviceStream.getAudioTracks()
			: media.deviceStream.getVideoTracks()
	return tracks.find((track) => track.readyState !== 'ended') ?? null
}

const presenceOf = (media: SelfMedia): MediaPresence => {
	if (media.status !== 'live') {
		return {
			cameraEnabled: false,
			microphoneEnabled: false,
			screenEnabled: false,
		}
	}

	const screenEnabled = media.screen.status === 'sharing'
	return {
		cameraEnabled:
			!screenEnabled && selfMediaDeviceTrack(media, 'video')?.enabled === true,
		microphoneEnabled: selfMediaDeviceTrack(media, 'audio')?.enabled === true,
		screenEnabled,
	}
}

const captureFailure = (error: unknown): SelfMedia => {
	const name =
		error instanceof DOMException
			? error.name
			: typeof error === 'object' &&
					error != null &&
					'name' in error &&
					typeof error.name === 'string'
				? error.name
				: null

	switch (name) {
		case 'NotAllowedError':
		case 'PermissionDeniedError':
		case 'SecurityError':
			return { status: 'denied' }
		case 'NotFoundError':
		case 'DevicesNotFoundError':
		case 'OverconstrainedError':
			return { status: 'missing' }
		case 'NotReadableError':
		case 'TrackStartError':
		case 'AbortError':
			return { status: 'busy' }
		default:
			return { status: 'error' }
	}
}

const captureDevices = async (): Promise<SelfMedia> => {
	if (!canCaptureDevices() || navigator.mediaDevices.getUserMedia == null) {
		return { status: 'unsupported' }
	}

	try {
		// Request both devices together so the preview matches what peers receive.
		const deviceStream = await navigator.mediaDevices.getUserMedia({
			audio: true,
			video: { facingMode: 'user' },
		})
		const tracks = [
			deviceStream.getAudioTracks()[0],
			deviceStream.getVideoTracks()[0],
		].filter((track): track is MediaStreamTrack => track != null)
		if (tracks.length === 0) {
			stopStream(deviceStream)
			return { status: 'missing' }
		}

		return {
			deviceStream,
			publishedStream: new MediaStream(tracks),
			screen: idleScreenCapture(),
			status: 'live',
		}
	} catch (error) {
		return captureFailure(error)
	}
}

/** Own local capture and publish its stable stream and presence to room peers. */
export const createRoomMediaController = (options: {
	connections: () => RoomConnection[]
	publishPresence: (presence: MediaPresence) => void
	selfMedia: () => SelfMedia
	setSelfMedia: (media: SelfMedia) => void
}) => {
	// Permission and screen-picker promises can outlive the room that started them.
	let captureVersion = 0
	let deviceTrackEndCleanup: (() => void) | null = null
	let screenTrackEndCleanup: (() => void) | null = null

	const commit = (media: SelfMedia) => {
		options.setSelfMedia(media)
		const stream = media.status === 'live' ? media.publishedStream : null
		for (const connection of options.connections()) {
			connection.rtc.setLocalMedia(stream)
		}
		options.publishPresence(presenceOf(media))
	}

	const clearScreenTrackEndListener = () => {
		screenTrackEndCleanup?.()
		screenTrackEndCleanup = null
	}

	const clearDeviceTrackEndListeners = () => {
		deviceTrackEndCleanup?.()
		deviceTrackEndCleanup = null
	}

	const watchDeviceEnds = (stream: MediaStream, version: number) => {
		clearDeviceTrackEndListeners()
		const tracks = stream.getTracks()
		const handleEnd = () => {
			const media = options.selfMedia()
			if (
				version !== captureVersion ||
				media.status !== 'live' ||
				media.deviceStream !== stream
			) {
				return
			}

			captureVersion++
			clearDeviceTrackEndListeners()
			clearScreenTrackEndListener()
			// Camera and microphone are one capture unit; retry both from a coherent state.
			stopSelfMedia(media)
			commit({ status: 'interrupted' })
		}

		for (const track of tracks) track.addEventListener('ended', handleEnd)
		deviceTrackEndCleanup = () => {
			for (const track of tracks) track.removeEventListener('ended', handleEnd)
		}
		if (tracks.some((track) => track.readyState === 'ended')) handleEnd()
	}

	const replacePublishedVideo = (
		media: LiveSelfMedia,
		track: MediaStreamTrack | null,
	) => {
		for (const current of media.publishedStream.getVideoTracks()) {
			media.publishedStream.removeTrack(current)
		}
		if (track != null) media.publishedStream.addTrack(track)
	}

	const stopScreenShare = (stopTracks = true) => {
		const media = options.selfMedia()
		if (media.status !== 'live') return

		clearScreenTrackEndListener()
		if (stopTracks) stopStream(media.screen.stream)
		replacePublishedVideo(media, selfMediaDeviceTrack(media, 'video'))
		commit({ ...media, screen: idleScreenCapture() })
	}

	const watchScreenEnd = (stream: MediaStream, version: number) => {
		clearScreenTrackEndListener()
		const track = stream.getVideoTracks()[0] ?? null
		if (track == null) return

		const handleEnd = () => {
			const media = options.selfMedia()
			if (
				version !== captureVersion ||
				media.status !== 'live' ||
				media.screen.stream !== stream
			) {
				return
			}
			stopScreenShare(false)
		}

		track.addEventListener('ended', handleEnd)
		screenTrackEndCleanup = () => track.removeEventListener('ended', handleEnd)
		if (track.readyState === 'ended') handleEnd()
	}

	const dispose = () => {
		captureVersion++
		clearDeviceTrackEndListeners()
		clearScreenTrackEndListener()
		stopSelfMedia(options.selfMedia())
		commit({ status: 'idle' })
	}

	const enable = async () => {
		const current = options.selfMedia()
		if (current.status === 'requesting') return

		const version = ++captureVersion
		clearDeviceTrackEndListeners()
		clearScreenTrackEndListener()
		stopSelfMedia(current)
		commit({ status: 'requesting' })

		const media = await captureDevices()
		if (version !== captureVersion) {
			stopSelfMedia(media)
			return
		}
		commit(media)
		if (media.status === 'live') watchDeviceEnds(media.deviceStream, version)
	}

	const toggleDevice = (kind: 'audio' | 'video') => {
		const media = options.selfMedia()
		const track = selfMediaDeviceTrack(media, kind)
		if (media.status !== 'live' || track == null) return

		track.enabled = !track.enabled
		options.setSelfMedia({ ...media })
		options.publishPresence(presenceOf(media))
	}

	const startScreenShare = async () => {
		const current = options.selfMedia()
		if (current.status !== 'live' || current.screen.status !== 'available') {
			return
		}

		const version = captureVersion
		options.setSelfMedia({
			...current,
			screen: { status: 'requesting', stream: null },
		})

		let stream: MediaStream
		try {
			stream = await navigator.mediaDevices.getDisplayMedia({
				audio: false,
				video: true,
			})
		} catch {
			const media = options.selfMedia()
			if (version === captureVersion && media.status === 'live') {
				options.setSelfMedia({ ...media, screen: idleScreenCapture() })
			}
			return
		}

		const track = stream.getVideoTracks()[0] ?? null
		const latest = options.selfMedia()
		if (
			version !== captureVersion ||
			latest.status !== 'live' ||
			latest.screen.status !== 'requesting' ||
			track == null
		) {
			stopStream(stream)
			return
		}

		replacePublishedVideo(latest, track)
		commit({
			...latest,
			screen: { status: 'sharing', stream },
		})
		watchScreenEnd(stream, version)
	}

	const toggleScreen = () => {
		const media = options.selfMedia()
		if (media.status !== 'live') return
		if (media.screen.status === 'sharing') {
			stopScreenShare()
			return
		}
		if (media.screen.status === 'available') void startScreenShare()
	}

	return {
		dispose,
		enable,
		presence: () => presenceOf(options.selfMedia()),
		toggleCamera: () => toggleDevice('video'),
		toggleMicrophone: () => toggleDevice('audio'),
		toggleScreen,
	}
}
