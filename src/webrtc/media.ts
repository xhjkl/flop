export function firstTrack(
	stream: MediaStream | null,
	kind: 'audio' | 'video',
) {
	return kind === 'audio'
		? (stream?.getAudioTracks()[0] ?? null)
		: (stream?.getVideoTracks()[0] ?? null)
}

export function trackSummary(track: MediaStreamTrack | null | undefined) {
	return track == null
		? null
		: {
				enabled: track.enabled,
				id: track.id,
				kind: track.kind,
				muted: track.muted,
				readyState: track.readyState,
			}
}

export function streamSummary(stream: MediaStream | null) {
	return {
		streamId: stream?.id ?? null,
		tracks: stream?.getTracks().map(trackSummary) ?? [],
	}
}

export function transceiverSummary(pc: RTCPeerConnection) {
	return pc.getTransceivers().map((transceiver, index) => ({
		currentDirection: transceiver.currentDirection,
		direction: transceiver.direction,
		index,
		mid: transceiver.mid,
		receiverTrack: trackSummary(transceiver.receiver.track),
		senderTrack: trackSummary(transceiver.sender.track),
	}))
}
