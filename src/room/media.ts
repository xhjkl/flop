import {
	captureScreenMedia,
	captureSelfMedia,
	emptySelfMedia,
	type SelfMedia,
	setSelfMediaTracksEnabled,
	stopMediaStream,
	stopSelfMedia,
	withOutboundSelfMediaStream,
} from '../self-media'
import type { PeerMediaState } from '../state'
import type { Peer } from '../webrtc'

/** Public media presence, stripped down to what another portrait can render. */
export const selfMediaState = (media: SelfMedia): PeerMediaState => {
	// Peers care about what we are actually sending, not permission details.
	return {
		cameraEnabled:
			media.status === 'live' && media.cameraAvailable && media.cameraEnabled,
		microphoneEnabled:
			media.status === 'live' &&
			media.microphoneAvailable &&
			media.microphoneEnabled,
		screenEnabled:
			media.status === 'live' &&
			media.screenEnabled &&
			media.screenStream != null,
	}
}

/** Self media controller: browser devices in, peer tracks and media-state packets out. */
export type RoomMediaController = {
	disposeSelfMedia: () => void
	enableSelfMedia: () => Promise<void>
	toggleCamera: () => void
	toggleMicrophone: () => void
	toggleScreen: () => void
}

/** Device lifecycle controller wired to the room's peer set and Solid store. */
export const createRoomMediaController = (options: {
	getSelfMedia: () => SelfMedia
	linkedPeers: () => Peer[]
	publishLocalMediaState: (mediaState?: PeerMediaState) => number
	setSelfMedia: (selfMedia: SelfMedia) => void
	setSelfMediaField: <Key extends keyof SelfMedia>(
		key: Key,
		value: SelfMedia[Key],
	) => void
}): RoomMediaController => {
	// Camera permission can race with teardown; versioning keeps late streams out.
	let selfMediaVersion = 0
	let screenTrackEndCleanup: (() => void) | null = null

	const publishSelfMedia = (stream: MediaStream | null) => {
		const peers = options.linkedPeers()

		for (const peer of peers) {
			peer.setLocalMedia(stream)
		}
	}

	const publishSelfMediaSnapshot = (selfMedia: SelfMedia) => {
		options.setSelfMedia(selfMedia)
		publishSelfMedia(selfMedia.outboundStream)
		options.publishLocalMediaState(selfMediaState(selfMedia))
	}

	const clearScreenTrackEndListener = () => {
		screenTrackEndCleanup?.()
		screenTrackEndCleanup = null
	}

	const stopScreenShare = (
		settings: { stopTracks?: boolean } = { stopTracks: true },
	) => {
		const selfMedia = options.getSelfMedia()
		clearScreenTrackEndListener()
		if (settings.stopTracks ?? true) stopMediaStream(selfMedia.screenStream)

		const nextSelfMedia = withOutboundSelfMediaStream({
			...selfMedia,
			screenEnabled: false,
			screenRequesting: false,
			screenStream: null,
		})
		publishSelfMediaSnapshot(nextSelfMedia)
	}

	const watchScreenMediaEnd = (screenStream: MediaStream, version: number) => {
		clearScreenTrackEndListener()
		const track = screenStream.getVideoTracks()[0] ?? null
		if (track == null) return

		const handleEnd = () => {
			if (
				version !== selfMediaVersion ||
				options.getSelfMedia().screenStream !== screenStream
			) {
				return
			}

			stopScreenShare({ stopTracks: false })
		}

		track.addEventListener('ended', handleEnd)
		screenTrackEndCleanup = () => track.removeEventListener('ended', handleEnd)
		if (track.readyState === 'ended') handleEnd()
	}

	const disposeSelfMedia = () => {
		// Media flow: local SelfMedia drives tracks on every link plus media-state packets.
		selfMediaVersion++
		clearScreenTrackEndListener()
		publishSelfMedia(null)
		stopSelfMedia(options.getSelfMedia())
		publishSelfMediaSnapshot(emptySelfMedia())
	}

	const enableSelfMedia = async () => {
		const current = options.getSelfMedia()
		if (current.status === 'requesting') return

		// Camera permission belongs to the self portrait, not to page load.
		const version = ++selfMediaVersion
		clearScreenTrackEndListener()
		publishSelfMedia(null)
		stopSelfMedia(current)
		options.setSelfMedia({
			...emptySelfMedia(),
			status: 'requesting',
		})

		const selfMedia = await captureSelfMedia()
		if (version !== selfMediaVersion) {
			stopSelfMedia(selfMedia)
			return
		}

		publishSelfMediaSnapshot(selfMedia)
	}

	const setTracksEnabled = (kind: 'audio' | 'video', enabled: boolean) => {
		// Toggling a track changes both local hardware state and remote affordances.
		const current = options.getSelfMedia()
		if (!setSelfMediaTracksEnabled(current, kind, enabled)) return

		const selfMedia = {
			...current,
			[kind === 'video' ? 'cameraEnabled' : 'microphoneEnabled']: enabled,
		}
		if (kind === 'video') {
			options.setSelfMediaField('cameraEnabled', enabled)
		} else {
			options.setSelfMediaField('microphoneEnabled', enabled)
		}
		options.publishLocalMediaState(selfMediaState(selfMedia))
	}

	const toggleCamera = () => {
		const selfMedia = options.getSelfMedia()
		if (!selfMedia.cameraAvailable) return
		setTracksEnabled('video', !selfMedia.cameraEnabled)
	}

	const toggleMicrophone = () => {
		const selfMedia = options.getSelfMedia()
		if (!selfMedia.microphoneAvailable) return
		setTracksEnabled('audio', !selfMedia.microphoneEnabled)
	}

	const startScreenShare = async () => {
		const current = options.getSelfMedia()
		if (
			current.status !== 'live' ||
			!current.screenAvailable ||
			current.screenRequesting
		) {
			return
		}

		const version = selfMediaVersion
		options.setSelfMediaField('screenRequesting', true)

		let screenStream: MediaStream
		try {
			screenStream = await captureScreenMedia()
		} catch {
			if (version === selfMediaVersion) {
				options.setSelfMediaField('screenRequesting', false)
			}
			return
		}

		const latest = options.getSelfMedia()
		if (version !== selfMediaVersion || latest.status !== 'live') {
			stopMediaStream(screenStream)
			return
		}

		clearScreenTrackEndListener()
		stopMediaStream(latest.screenStream)
		const selfMedia = withOutboundSelfMediaStream({
			...latest,
			issue: null,
			screenEnabled: true,
			screenRequesting: false,
			screenStream,
		})
		publishSelfMediaSnapshot(selfMedia)
		watchScreenMediaEnd(screenStream, version)
	}

	const toggleScreen = () => {
		const selfMedia = options.getSelfMedia()
		if (selfMedia.screenRequesting) return
		if (selfMedia.screenEnabled) {
			stopScreenShare()
			return
		}

		void startScreenShare()
	}

	return {
		disposeSelfMedia,
		enableSelfMedia,
		toggleCamera,
		toggleMicrophone,
		toggleScreen,
	}
}
