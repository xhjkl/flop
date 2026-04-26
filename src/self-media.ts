export type SelfMediaStatus =
	| 'ready'
	| 'requesting'
	| 'live'
	| 'denied'
	| 'missing'
	| 'unsupported'
	| 'error'

// These are card states, not just device states. Each one has to explain itself to a person.
export type SelfMedia = {
	status: SelfMediaStatus
	issue: string | null
	stream: MediaStream | null
	cameraAvailable: boolean
	cameraEnabled: boolean
	microphoneAvailable: boolean
	microphoneEnabled: boolean
}

export const emptySelfMedia = (): SelfMedia => {
	return {
		status: 'ready',
		issue: null,
		stream: null,
		cameraAvailable: false,
		cameraEnabled: false,
		microphoneAvailable: false,
		microphoneEnabled: false,
	}
}

export const stopSelfMedia = (media: SelfMedia) => {
	for (const track of media.stream?.getTracks() ?? []) {
		track.stop()
	}
}

export const setSelfMediaTracksEnabled = (
	media: SelfMedia,
	kind: 'audio' | 'video',
	enabled: boolean,
) => {
	const tracks =
		kind === 'video'
			? (media.stream?.getVideoTracks() ?? [])
			: (media.stream?.getAudioTracks() ?? [])
	if (tracks.length === 0) return false

	for (const track of tracks) {
		track.enabled = enabled
	}

	return true
}

export const captureSelfMedia = async (): Promise<SelfMedia> => {
	if (navigator.mediaDevices?.getUserMedia == null) {
		return {
			...emptySelfMedia(),
			status: 'unsupported',
			issue: 'This browser cannot open the camera and microphone here.',
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

		return {
			status: 'live',
			issue: null,
			stream,
			cameraAvailable,
			cameraEnabled: cameraAvailable,
			microphoneAvailable,
			microphoneEnabled: microphoneAvailable,
		}
	} catch (error) {
		return { ...emptySelfMedia(), ...classifySelfMediaFailure(error) }
	}
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
					'Camera or microphone access was denied. Allow it in the browser, then try again.',
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
					'The browser could not start the camera or microphone. Another app may already be using them.',
			}
		default:
			return {
				status: 'error',
				issue: 'The browser could not open the camera and microphone.',
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
