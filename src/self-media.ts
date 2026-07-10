/** Permission/device outcome rendered by the self media card. */
export type SelfMediaStatus =
	| 'ready'
	| 'requesting'
	| 'live'
	| 'denied'
	| 'missing'
	| 'unsupported'
	| 'error'

/** Self portrait media state; each branch has to explain itself to a person. */
export type SelfMedia = {
	status: SelfMediaStatus
	issue: string | null
	/** Composite stream currently published to peers and the local preview. */
	outboundStream: MediaStream | null
	/** Original camera-and-microphone capture returned by getUserMedia. */
	deviceStream: MediaStream | null
	screenStream: MediaStream | null
	cameraAvailable: boolean
	cameraEnabled: boolean
	microphoneAvailable: boolean
	microphoneEnabled: boolean
	screenAvailable: boolean
	screenEnabled: boolean
	screenRequesting: boolean
}

const canCaptureSelfMedia = () => {
	return typeof navigator !== 'undefined' && navigator.mediaDevices != null
}

const canCaptureScreen = () => {
	return (
		canCaptureSelfMedia() &&
		typeof navigator.mediaDevices.getDisplayMedia === 'function'
	)
}

export const emptySelfMedia = (): SelfMedia => {
	return {
		status: 'ready',
		issue: null,
		outboundStream: null,
		deviceStream: null,
		screenStream: null,
		cameraAvailable: false,
		cameraEnabled: false,
		microphoneAvailable: false,
		microphoneEnabled: false,
		screenAvailable: canCaptureScreen(),
		screenEnabled: false,
		screenRequesting: false,
	}
}

export const stopMediaStream = (stream: MediaStream | null) => {
	for (const track of stream?.getTracks() ?? []) {
		track.stop()
	}
}

export const stopSelfMedia = (media: SelfMedia) => {
	const tracks = new Set<MediaStreamTrack>()
	for (const stream of [
		media.outboundStream,
		media.deviceStream,
		media.screenStream,
	]) {
		for (const track of stream?.getTracks() ?? []) {
			tracks.add(track)
		}
	}

	for (const track of tracks) {
		track.stop()
	}
}

/** Audio plus the selected camera or screen track sent to peers. */
export const outboundSelfMediaStream = (media: SelfMedia) => {
	const tracks: MediaStreamTrack[] = []
	const audioTrack = media.deviceStream?.getAudioTracks()[0] ?? null
	if (audioTrack != null) tracks.push(audioTrack)

	const screenTrack = media.screenStream?.getVideoTracks()[0] ?? null
	const cameraTrack = media.deviceStream?.getVideoTracks()[0] ?? null
	const videoTrack =
		media.screenEnabled && screenTrack != null ? screenTrack : cameraTrack
	if (videoTrack != null) tracks.push(videoTrack)

	return tracks.length === 0 ? null : new MediaStream(tracks)
}

/** Self media snapshot with its peer-facing stream rebuilt from source streams. */
export const withOutboundSelfMediaStream = (media: SelfMedia): SelfMedia => {
	return { ...media, outboundStream: outboundSelfMediaStream(media) }
}

export const setSelfMediaTracksEnabled = (
	media: SelfMedia,
	kind: 'audio' | 'video',
	enabled: boolean,
) => {
	const tracks =
		kind === 'video'
			? (media.deviceStream?.getVideoTracks() ?? [])
			: (media.deviceStream?.getAudioTracks() ?? [])
	if (tracks.length === 0) return false

	for (const track of tracks) {
		track.enabled = enabled
	}

	return true
}

export const captureSelfMedia = async (): Promise<SelfMedia> => {
	if (!canCaptureSelfMedia() || navigator.mediaDevices.getUserMedia == null) {
		return {
			...emptySelfMedia(),
			status: 'unsupported',
			issue: 'This browser cannot open camera and microphone here.',
		}
	}

	try {
		// One tap opens both tracks; the user gets a truthful preview before going live.
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: true,
			video: { facingMode: 'user' },
		})
		const cameraAvailable = stream.getVideoTracks().length > 0
		const microphoneAvailable = stream.getAudioTracks().length > 0

		return withOutboundSelfMediaStream({
			...emptySelfMedia(),
			status: 'live',
			issue: null,
			deviceStream: stream,
			cameraAvailable,
			cameraEnabled: cameraAvailable,
			microphoneAvailable,
			microphoneEnabled: microphoneAvailable,
		})
	} catch (error) {
		return { ...emptySelfMedia(), ...classifySelfMediaFailure(error) }
	}
}

export const captureScreenMedia = async () => {
	if (!canCaptureScreen()) {
		throw new Error('Screen sharing is unavailable')
	}

	const stream = await navigator.mediaDevices.getDisplayMedia({
		audio: false,
		video: true,
	})
	if (stream.getVideoTracks().length === 0) {
		stopMediaStream(stream)
		throw new Error('Screen sharing returned no video track')
	}

	return stream
}

const classifySelfMediaFailure = (
	error: unknown,
): {
	status: SelfMediaStatus
	issue: string
} => {
	const name = error instanceof DOMException ? error.name : namedError(error)

	switch (name) {
		case 'NotAllowedError':
		case 'PermissionDeniedError':
		case 'SecurityError':
			return {
				status: 'denied',
				issue:
					'Camera or microphone access was denied. Allow access in your browser, then try again.',
			}
		case 'NotFoundError':
		case 'DevicesNotFoundError':
		case 'OverconstrainedError':
			return {
				status: 'missing',
				issue:
					'No working camera or microphone was found. Connect one and try again.',
			}
		case 'NotReadableError':
		case 'TrackStartError':
		case 'AbortError':
			return {
				status: 'error',
				issue:
					'This browser could not start camera or microphone. Another app may already be using a device.',
			}
		default:
			return {
				status: 'error',
				issue: 'This browser could not open camera and microphone.',
			}
	}
}

const namedError = (error: unknown) => {
	return typeof error === 'object' &&
		error != null &&
		'name' in error &&
		typeof error.name === 'string'
		? error.name
		: null
}
