export const firstTrack = (
	stream: MediaStream | null,
	kind: 'audio' | 'video',
) => {
	return kind === 'audio'
		? (stream?.getAudioTracks()[0] ?? null)
		: (stream?.getVideoTracks()[0] ?? null)
}
